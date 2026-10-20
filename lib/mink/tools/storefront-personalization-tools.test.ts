import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "../types";

const holder = vi.hoisted(() => ({
  propose: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../storefront-personalization-proposals", () => ({
  createMinkStorefrontPersonalizationProposal: holder.propose,
}));
vi.mock("../storefront-personalization-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../storefront-personalization-context")
  >()),
  readPersonalizationTarget: holder.read,
  summarizePersonalizationTarget: vi.fn(() => ({ store: { name: "Lumen" } })),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import {
  PERSONALIZATION_PROPOSAL_TOOL,
  minkStorefrontPersonalizationTools,
} from "./storefront-personalization-tools";

const [contextTool, proposeTool] = minkStorefrontPersonalizationTools;

const actor = (draftingEnabled = true) =>
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
    draftingEnabled,
  }) as MinkActorContext;

const artifact = {
  type: "storefront_personalization_proposal",
  draftId: "d",
  title: "Personalised storefront",
  explanation: "e",
  planDigest: "a".repeat(64),
  pages: [
    {
      slug: "home",
      title: "Home",
      textChanges: 5,
      photoChanges: 1,
      hidden: [{ type: "testimonials", reason: "r" }],
    },
  ],
  photos: [{ url: "u", alt: "a", where: "w" }],
  design: null,
  chrome: [{ label: "Store tagline", before: "", after: "x" }],
  categories: [],
  products: [{ name: "Apples (Sample)" }],
  skipped: [],
  live: ["Theme sample products taken off the shop"],
  status: "private_preview",
  expectedCredits: 47,
  chargedCredits: 47,
  creditSource: "plan",
};

beforeEach(() => {
  holder.propose.mockResolvedValue(artifact);
  holder.read.mockResolvedValue({});
});

describe("the storefront personalisation tools", () => {
  it("are offered only where Mink may draft, behind Website Builder permissions", () => {
    expect(contextTool.declaration.name).toBe(
      "get_storefront_personalization_context",
    );
    expect(proposeTool.declaration.name).toBe(PERSONALIZATION_PROPOSAL_TOOL);
    expect(contextTool.permission).toEqual({
      section: "builder",
      action: "view",
    });
    expect(proposeTool.permission).toEqual({
      section: "builder",
      action: "manage",
    });
    for (const tool of minkStorefrontPersonalizationTools) {
      expect(tool.available?.(actor(true))).toBe(true);
      expect(tool.available?.(actor(false))).toBe(false);
    }
  });

  it("★ the context read is a repeat-safe read; the proposal is neither repeat- nor restart-safe", () => {
    expect(contextTool.repeatSafe).toBe(true);
    expect(proposeTool.repeatSafe).not.toBe(true);
    expect(proposeTool.restartSafe).not.toBe(true);
  });

  it("★ gives the long call room to finish inside the run", () => {
    expect(proposeTool.timeoutMs).toBeGreaterThan(170_000);
    expect(proposeTool.runBudgetMs).toBeGreaterThan(proposeTool.timeoutMs);
  });

  it("★★ tells the model what changed, never the plan or a credit figure", async () => {
    const output = await proposeTool.execute(actor(), { explanation: "x" });
    expect(proposeTool.artifact?.(output)).toBe(artifact);
    expect(output.summary).toEqual({
      pages: [
        { page: "Home", textChanges: 5, newPhotos: 1, hiddenSampleSections: 1 },
      ],
      newPhotos: 1,
      lookChanged: false,
      headerFooterChanges: ["Store tagline"],
      categoryChanges: 0,
      sampleProductsToUnpublish: 1,
      notDoneThisTime: [],
      liveAtOnceWhenApplied: ["Theme sample products taken off the shop"],
    });
    expect(JSON.stringify(output.summary)).not.toMatch(/credit|47/i);
    expect(output.authority).toEqual({
      canPreview: true,
      canSaveBuilderDraft: false,
      canPublish: false,
    });
  });

  it("asks for confirmed categories and never people in photos, in its own schema", () => {
    const schema = JSON.stringify(proposeTool.declaration.parametersJsonSchema);
    expect(schema).toContain("merchant_confirmed");
    expect(schema).toContain("photos_only");
    expect(schema).toMatch(/never people/);
    expect(proposeTool.declaration.description).not.toMatch(/—/);
  });
});
