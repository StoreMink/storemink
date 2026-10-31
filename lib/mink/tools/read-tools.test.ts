import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedMediaSet } from "@/lib/moderation/blocked-objects";
import type { MinkActorContext } from "../types";

const mocks = vi.hoisted(() => ({
  enqueueBrief: vi.fn(),
  readCatalog: vi.fn(),
  readByLocation: vi.fn(),
  resolveLocation: vi.fn(),
  enqueueWorkflow: vi.fn(),
  enqueueRevenueWorkflow: vi.fn(),
  enqueueLaunchWorkflow: vi.fn(),
  enqueueSlowInventoryWorkflow: vi.fn(),
  enqueueDelayedPickupWorkflow: vi.fn(),
  readStorefrontPages: vi.fn(),
  readStorefrontPage: vi.fn(),
  readStorefrontSection: vi.fn(),
  readStorefrontDesign: vi.fn(),
  proposeStorefrontCode: vi.fn(),
  readOffers: vi.fn(),
  readLowStock: vi.fn(),
  selectRows: [] as Record<string, unknown>[],
  marks: new Map<string, string>(),
  blockedSet: null as BlockedMediaSet | null,
}));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  // A select chain that answers with this test's rows, whatever it asks.
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "where", "orderBy"]) chain[step] = () => chain;
  chain.limit = async () => mocks.selectRows;
  return {
    ...actual,
    withUser: vi.fn(async (_identity: unknown, run: (db: unknown) => unknown) =>
      run({ select: () => chain }),
    ),
  };
});
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => mocks.marks),
}));
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  const current = () => mocks.blockedSet ?? actual.emptyBlockedMediaSet(1, "b");
  return {
    ...actual,
    blockedMedia: vi.fn(async () => current()),
    maskBlockedMedia: vi.fn(async (value: unknown) =>
      actual.maskBlockedMediaWith(value, current()),
    ),
  };
});
vi.mock("../catalog-health-read", () => ({
  readMinkCatalogHealth: mocks.readCatalog,
  readMinkCatalogHealthByLocation: mocks.readByLocation,
}));
vi.mock("./location-scope", () => ({
  resolveMinkLocation: mocks.resolveLocation,
}));
vi.mock("../workflows", () => ({
  enqueueBusinessBrief: mocks.enqueueBrief,
  enqueueWeeklyTradingReport: mocks.enqueueWorkflow,
  enqueueRevenueDeclineInvestigation: mocks.enqueueRevenueWorkflow,
  enqueueProductLaunchPreparation: mocks.enqueueLaunchWorkflow,
  enqueueSlowInventoryPromotion: mocks.enqueueSlowInventoryWorkflow,
  enqueueDelayedPickupReview: mocks.enqueueDelayedPickupWorkflow,
}));
vi.mock("../storefront-context-read", async (importOriginal) => ({
  // The takedown mark helper is the real one, over the mocks above.
  withStoreMinkBlocks: (
    await importOriginal<typeof import("../storefront-context-read")>()
  ).withStoreMinkBlocks,
  readMinkStorefrontPages: mocks.readStorefrontPages,
  readMinkStorefrontPageContext: mocks.readStorefrontPage,
  readMinkStorefrontSectionContext: mocks.readStorefrontSection,
  readMinkStorefrontDesignContext: mocks.readStorefrontDesign,
}));
vi.mock("../storefront-code-proposals", () => ({
  createMinkStorefrontCodeProposal: mocks.proposeStorefrontCode,
}));
vi.mock("../offers-read", () => ({
  readMinkCurrentOffers: mocks.readOffers,
}));
vi.mock("@/lib/inventory/low-stock-read", () => ({
  readLowStockItems: mocks.readLowStock,
}));

import { withUser } from "@/lib/db/client";
import { buildBlockedMediaSet } from "@/lib/moderation/blocked-objects";
import { blockedItemIds } from "@/lib/moderation/merchant";
import { PLACEHOLDER_URL_PATH } from "@/lib/moderation/placeholder";
import { minkReadToolRegistry } from "./read-tools";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
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
  requestId: "request-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows = [];
  mocks.marks = new Map();
  mocks.blockedSet = null;
  mocks.resolveLocation.mockResolvedValue({
    locationIds: null,
    selectedId: null,
    label: "All store locations",
    includeUnassigned: true,
    availableLocations: [
      { id: "shop-1", name: "Shop", type: "shop" },
      { id: "delhi-1", name: "Delhi", type: "warehouse" },
    ],
  });
  mocks.readCatalog.mockResolvedValue({
    total: 14,
    published: 14,
    unpublished: 0,
    draft: 0,
    archived: 0,
    inventoryItems: 16,
    lowStock: 1,
    outOfStock: 0,
    items: [],
    truncated: false,
  });
  mocks.enqueueWorkflow.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    template: "weekly_trading_report",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueRevenueWorkflow.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    template: "revenue_decline_investigation",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueLaunchWorkflow.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    template: "product_launch_preparation",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueSlowInventoryWorkflow.mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
    template: "slow_inventory_promotion",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueDelayedPickupWorkflow.mockResolvedValue({
    id: "55555555-5555-4555-8555-555555555555",
    template: "delayed_pickup_review",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.readStorefrontPages.mockResolvedValue({
    pages: [
      {
        pageSlug: "home",
        title: "Home",
        status: "published",
        draftSectionCount: 3,
        hasUnpublishedChanges: true,
        requiresRepair: false,
        dashboardPath: "/dashboard/builder?page=home",
      },
    ],
    dataAsOf: "2026-09-04T10:00:00.000Z",
    dashboardPath: "/dashboard/builder",
  });
  mocks.readStorefrontPage.mockResolvedValue({
    page: { pageSlug: "home", title: "Home", hasUnpublishedChanges: true },
    sections: [
      {
        id: "section-1",
        position: 1,
        type: "hero",
        enabled: true,
        summary: "Hero · Welcome",
      },
    ],
    dashboardPath: "/dashboard/builder?page=home",
  });
  mocks.readStorefrontSection.mockResolvedValue({
    pageSlug: "home",
    section: {
      id: "section-1",
      position: 1,
      type: "hero",
      enabled: true,
      summary: "Hero · Welcome",
    },
    dashboardPath: "/dashboard/builder?page=home&section=section-1",
  });
  mocks.readStorefrontDesign.mockResolvedValue({
    brand: { name: "Echos", primaryColor: "#6d4aff" },
    theme: { id: "studio", name: "Studio", version: "0.1.0" },
    chrome: { chromeVersion: "2026-09-04T10:00:00Z" },
    capabilities: { customCodeEnabled: true },
    dashboardPath: "/dashboard/builder",
  });
  mocks.proposeStorefrontCode.mockResolvedValue({
    type: "storefront_code_proposal",
    draftId: "66666666-6666-4666-8666-666666666666",
    title: "Storefront code for Home",
    destinationLabel: "Home · custom code",
    destinationPath: "/dashboard/builder?page=home&section=section-1",
    status: "private_preview",
  });
  mocks.readOffers.mockResolvedValue({
    runningCount: 1,
    automaticOffersEnabled: true,
    offers: [
      {
        name: "Almond shake BOGO",
        availability: "running",
        delivery: "automatic",
        reward: "Buy 1, get 1 free",
        trigger: "on any order",
        appliesTo: {
          allProducts: false,
          products: ["Almond shake"],
          variants: [],
          categories: [],
          summary: "Almond shake",
          truncated: false,
        },
      },
      {
        name: "October launch",
        availability: "scheduled",
        delivery: "code",
        code: "OCT10",
        reward: "10% off the order",
        trigger: "on any order",
      },
    ],
    truncated: false,
    dataAsOf: "2026-09-13T10:30:00.000Z",
    dashboardPath: "/dashboard/offers",
  });
});

describe("business brief tool", () => {
  it.each([undefined, "daily", "weekly"])(
    "queues %s with trusted actor context and a progress card",
    async (period) => {
      mocks.enqueueBrief.mockResolvedValue({
        id: "brief-1",
        status: "queued",
        currentStep: 0,
        totalSteps: 3,
      });
      const result = await minkReadToolRegistry.execute(ACTOR, {
        name: "start_business_brief",
        args: { period, location_name: "Delhi" },
      });
      expect(mocks.enqueueBrief).toHaveBeenCalledWith(ACTOR, {
        period: period ?? "daily",
        locationName: "Delhi",
      });
      expect(result.artifact).toMatchObject({
        type: "workflow",
        template: "business_brief",
        runId: "brief-1",
      });
    },
  );
  it.each([
    { period: "hourly" },
    { period: 7 },
    { store_id: "other" },
    { schedule: "every day" },
  ])("rejects unsupported input %j", async (args) => {
    const result = await minkReadToolRegistry.execute(ACTOR, {
      name: "start_business_brief",
      args,
    });
    expect(result.response).toHaveProperty("error");
    expect(mocks.enqueueBrief).not.toHaveBeenCalled();
  });
  it.each(["analytics", "products", "inventory", "orders"] as const)(
    "requires %s View at discovery and execution",
    async (missing) => {
      const permissions: MinkActorContext["permissions"] = {
        analytics: ["view"],
        products: ["view"],
        inventory: ["view"],
        orders: ["view"],
      };
      permissions[missing] = [];
      const actor = { ...ACTOR, isSuperadmin: false, permissions };
      expect(
        minkReadToolRegistry.declarationsFor(actor).map((tool) => tool.name),
      ).not.toContain("start_business_brief");
      const result = await minkReadToolRegistry.execute(actor, {
        name: "start_business_brief",
        args: {},
      });
      expect(result.response).toMatchObject({
        error: { code: "permission_denied" },
      });
      expect(mocks.enqueueBrief).not.toHaveBeenCalled();
    },
  );
});

describe("Phase 9D media library tool", () => {
  /**
   * ★ IT IS GATED ON `media`, NOT `builder`, even though its only consumer is
   *   a Builder proposal. Filenames alone can carry a supplier's name or an
   *   unreleased product's, and an admin trusted to arrange a page is not
   *   automatically trusted to enumerate every file the store has uploaded.
   */
  it("is withheld from a Builder admin who cannot view Media", async () => {
    const actor = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { builder: ["view", "manage"], media: [] },
    } as MinkActorContext;
    expect(
      minkReadToolRegistry.declarationsFor(actor).map((tool) => tool.name),
    ).not.toContain("list_storefront_media");
    const result = await minkReadToolRegistry.execute(actor, {
      name: "list_storefront_media",
      args: {},
    });
    expect(result.response).toMatchObject({
      error: { code: "permission_denied" },
    });
  });

  it("is offered with Media view alone", () => {
    expect(
      minkReadToolRegistry
        .declarationsFor({
          ...ACTOR,
          isSuperadmin: false,
          permissions: { media: ["view"] },
        } as MinkActorContext)
        .map((tool) => tool.name),
    ).toContain("list_storefront_media");
  });

  it("requires an explicit reference-read result for image generation", () => {
    const imageTool = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { media: ["manage"] },
      } as MinkActorContext)
      .find((tool) => tool.name === "generate_storefront_image");
    expect(imageTool?.parametersJsonSchema).toMatchObject({
      additionalProperties: false,
      required: ["purpose", "prompt", "reference_image_urls", "alt"],
      properties: {
        reference_image_urls: {
          type: "array",
          maxItems: 4,
          uniqueItems: true,
        },
      },
    });
  });

  function blogDeclarationFor(overrides: Partial<MinkActorContext>) {
    return minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        draftingEnabled: true,
        ...overrides,
      } as MinkActorContext)
      .find((tool) => tool.name === "propose_blog_draft");
  }

  it("requires every new blog proposal to carry its finished cover", () => {
    const blogTool = blogDeclarationFor({
      isSuperadmin: false,
      permissions: { blogs: ["manage"], media: ["view"] },
    });
    expect(blogTool?.parametersJsonSchema).toMatchObject({
      required: ["title", "excerpt", "content", "cover_image_url"],
      properties: {
        cover_image_url: { type: "string", minLength: 1, maxLength: 2_048 },
      },
    });
  });

  // ★★ EVERY COVER URL COMES FROM A TOOL BEHIND A PERMISSION THIS ONE DOES NOT
  //    REQUIRE — list_storefront_media (media:view), generate_storefront_image
  //    (media:manage) and the catalogue reads (products:view). A flatly
  //    mandatory cover therefore failed EVERY blog proposal from a
  //    blogs:manage-only admin on an argument nothing could give them.
  it("drops the cover requirement for an admin with no image permission", () => {
    const blogTool = blogDeclarationFor({
      isSuperadmin: false,
      permissions: { blogs: ["manage"] },
    });
    expect(blogTool).toBeDefined();
    expect(
      (blogTool?.parametersJsonSchema as { required: string[] }).required,
    ).toEqual(["title", "excerpt", "content"]);
    expect(blogTool?.description).toContain("omit cover_image_url");
  });

  it.each([
    ["media:view", { blogs: ["manage"], media: ["view"] }],
    ["media:manage", { blogs: ["manage"], media: ["manage"] }],
    ["products:view", { blogs: ["manage"], products: ["view"] }],
    ["categories:view", { blogs: ["manage"], categories: ["view"] }],
  ])("keeps the cover required for an admin holding %s", (_label, perms) => {
    const blogTool = blogDeclarationFor({
      isSuperadmin: false,
      permissions: perms as MinkActorContext["permissions"],
    });
    expect(
      (blogTool?.parametersJsonSchema as { required: string[] }).required,
    ).toContain("cover_image_url");
  });
});

describe("Mink read-tool declarations", () => {
  it("never lets the model provide a tenant or actor identifier", () => {
    const declarations = minkReadToolRegistry.declarationsFor(ACTOR);

    expect(declarations.map((tool) => tool.name)).toEqual([
      "get_store_profile",
      "list_blogs",
      "list_storefront_pages",
      "get_storefront_page_context",
      "get_storefront_section_context",
      "get_storefront_design_context",
      "list_storefront_media",
      "get_catalog_summary",
      "search_storefront_categories",
      "search_products",
      "get_sales_summary",
      "query_analytics",
      "list_current_offers",
      "get_shipping_settings",
      "get_marketing_channels",
      "list_low_stock",
      "start_business_brief",
      "get_mink_watches",
      "get_mink_watch_responses",
      "start_weekly_trading_report",
      "start_revenue_decline_investigation",
      "start_product_launch_preparation",
      "list_orders",
      "search_help_centre",
      "open_dashboard_page",
      "get_website_builder_context",
    ]);
    for (const declaration of declarations) {
      const properties = declaration.parametersJsonSchema.properties as
        | Record<string, unknown>
        | undefined;
      expect(properties).not.toHaveProperty("storeId");
      expect(properties).not.toHaveProperty("store_id");
      expect(properties).not.toHaveProperty("adminId");
      expect(properties).not.toHaveProperty("permissions");
    }
    const catalog = declarations.find(
      (tool) => tool.name === "get_catalog_summary",
    );
    expect(catalog?.parametersJsonSchema).toMatchObject({
      additionalProperties: false,
      required: ["inventory_scope"],
      properties: {
        inventory_scope: {
          type: "string",
          enum: [
            "publication_only",
            "clarify",
            "combined",
            "by_location",
            "location",
          ],
        },
        location_name: { type: "string", maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 20 },
      },
    });
  });

  it("exposes each business tool only with its trusted section permission", () => {
    const declared = (permissions: MinkActorContext["permissions"]) =>
      minkReadToolRegistry
        .declarationsFor({ ...ACTOR, isSuperadmin: false, permissions })
        .map((tool) => tool.name);

    expect(declared({ dashboard: ["view"] })).toEqual([
      "get_store_profile",
      "get_mink_watches",
      "get_mink_watch_responses",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(declared({ builder: ["view"] })).toEqual([
      "list_storefront_pages",
      "get_storefront_page_context",
      "get_storefront_section_context",
      "get_storefront_design_context",
      "get_website_builder_context",
    ]);
    expect(declared({ dashboard: ["view"], products: ["view"] })).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "get_mink_watches",
      "get_mink_watch_responses",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(declared({ categories: ["view"] })).toEqual([
      "search_storefront_categories",
    ]);
    expect(declared({ dashboard: ["view"], analytics: ["view"] })).toEqual([
      "get_store_profile",
      "get_sales_summary",
      "query_analytics",
      "get_mink_watches",
      "get_mink_watch_responses",
      "start_weekly_trading_report",
      "start_revenue_decline_investigation",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(declared({ promotions: ["view"] })).toEqual(["list_current_offers"]);
    expect(declared({ settings: ["view"] })).toEqual(["get_shipping_settings"]);
    expect(declared({ marketing: ["view"] })).toEqual([
      "get_marketing_channels",
    ]);
    expect(declared({ blogs: ["view"] })).toEqual(["list_blogs"]);
    expect(declared({ dashboard: ["view"], inventory: ["view"] })).toEqual([
      "get_store_profile",
      "list_low_stock",
      "get_mink_watches",
      "get_mink_watch_responses",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(
      declared({
        dashboard: ["view"],
        products: ["view"],
        inventory: ["view"],
      }),
    ).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "list_low_stock",
      "get_mink_watches",
      "get_mink_watch_responses",
      "start_product_launch_preparation",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(declared({ dashboard: ["view"], orders: ["view"] })).toEqual([
      "get_store_profile",
      "get_mink_watches",
      "get_mink_watch_responses",
      "list_orders",
      "search_help_centre",
      "open_dashboard_page",
    ]);
    expect(
      minkReadToolRegistry
        .declarationsFor({
          ...ACTOR,
          isSuperadmin: false,
          draftingEnabled: true,
          permissions: { orders: ["view", "manage"] },
        })
        .map((tool) => tool.name),
    ).toEqual([
      "start_delayed_pickup_review",
      "list_orders",
      "get_order_for_status_transition",
      "propose_order_status_transition",
    ]);
    expect(
      minkReadToolRegistry
        .declarationsFor({
          ...ACTOR,
          isSuperadmin: false,
          draftingEnabled: true,
          permissions: {
            dashboard: ["view"],
            analytics: ["view"],
            products: ["view"],
            inventory: ["view"],
            promotions: ["manage"],
          },
        })
        .map((tool) => tool.name),
    ).toContain("start_slow_inventory_promotion");
    expect(
      minkReadToolRegistry
        .declarationsFor({
          ...ACTOR,
          isSuperadmin: false,
          draftingEnabled: false,
          permissions: {
            analytics: ["view"],
            products: ["view"],
            inventory: ["view"],
            promotions: ["manage"],
          },
        })
        .map((tool) => tool.name),
    ).not.toContain("start_slow_inventory_promotion");
  });

  it("reads current offers only through Offers View and returns a bounded card", async () => {
    const actor = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { promotions: ["view"] },
    } as MinkActorContext;
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-offers",
      name: "list_current_offers",
      args: { limit: 20 },
    });

    expect(mocks.readOffers).toHaveBeenCalledWith(actor, { limit: 20 });
    expect(result.response.output).toMatchObject({ runningCount: 1 });
    expect(result.artifact).toMatchObject({
      type: "records",
      title: "Current offers",
      recordType: "offer",
      records: expect.arrayContaining([
        expect.objectContaining({
          title: "Almond shake BOGO",
          subtitle: expect.stringContaining("Applies to Almond shake"),
          status: "running",
        }),
      ]),
      filters: expect.arrayContaining([{ label: "Running now", value: "1" }]),
    });
  });

  it("forwards only exact bounded builder selectors and returns storefront artifacts", async () => {
    const page = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-page",
      name: "get_storefront_page_context",
      args: { page_slug: "home" },
    });
    expect(mocks.readStorefrontPage).toHaveBeenCalledWith(ACTOR, {
      pageSlug: "home",
    });
    expect(page.artifact).toMatchObject({
      type: "records",
      recordType: "storefront",
      records: [{ id: "section-1" }],
    });

    const section = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-section",
      name: "get_storefront_section_context",
      args: {
        page_slug: "home",
        section_id: "section-1",
        code_field: "css",
        code_offset: 8_000,
      },
    });
    expect(mocks.readStorefrontSection).toHaveBeenCalledWith(ACTOR, {
      pageSlug: "home",
      sectionId: "section-1",
      codeField: "css",
      codeOffset: 8_000,
    });
    expect(section.artifact).toMatchObject({
      recordType: "storefront",
      records: [{ id: "section-1" }],
    });

    const declaration = minkReadToolRegistry
      .declarationsFor(ACTOR)
      .find((tool) => tool.name === "get_storefront_section_context");
    expect(declaration?.parametersJsonSchema).toMatchObject({
      required: ["page_slug", "section_id"],
      additionalProperties: false,
      properties: {
        code_field: { enum: ["html", "css", "js"] },
        code_offset: { minimum: 0, maximum: 65_536 },
      },
    });
  });

  it("queues bounded Phase 6B and 6C workflows through permission-gated tools", async () => {
    const actor = { ...ACTOR, draftingEnabled: true, runId: "run-1" };
    const revenue = await minkReadToolRegistry.execute(actor, {
      id: "call-revenue",
      name: "start_revenue_decline_investigation",
      args: { period: "30d", location_name: "Shop" },
    });
    expect(mocks.enqueueRevenueWorkflow).toHaveBeenCalledWith(actor, {
      period: "30d",
      locationName: "Shop",
    });
    expect(revenue.artifact).toMatchObject({
      type: "workflow",
      template: "revenue_decline_investigation",
      runId: "22222222-2222-4222-8222-222222222222",
    });

    const launch = await minkReadToolRegistry.execute(actor, {
      id: "call-launch",
      name: "start_product_launch_preparation",
      args: { product_sku: "SKU10010007V028" },
    });
    expect(mocks.enqueueLaunchWorkflow).toHaveBeenCalledWith(actor, {
      productSku: "SKU10010007V028",
    });
    expect(launch.artifact).toMatchObject({
      type: "workflow",
      template: "product_launch_preparation",
      runId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("queues the Phase 6D shelf analysis with a bounded period and exact location", async () => {
    const actor = { ...ACTOR, draftingEnabled: true, runId: "run-1" };
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-slow-inventory",
      name: "start_slow_inventory_promotion",
      args: { period: "90d", location_name: "Delhi warehouse" },
    });

    expect(mocks.enqueueSlowInventoryWorkflow).toHaveBeenCalledWith(actor, {
      period: "90d",
      locationName: "Delhi warehouse",
    });
    expect(result.artifact).toMatchObject({
      type: "workflow",
      template: "slow_inventory_promotion",
      runId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("queues the Phase 6E pickup review for one exact location without a recipient", async () => {
    const actor = { ...ACTOR, draftingEnabled: true, runId: "run-1" };
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-delayed-pickups",
      name: "start_delayed_pickup_review",
      args: { location_name: "Delhi warehouse" },
    });

    expect(mocks.enqueueDelayedPickupWorkflow).toHaveBeenCalledWith(actor, {
      locationName: "Delhi warehouse",
    });
    expect(result.artifact).toMatchObject({
      type: "workflow",
      template: "delayed_pickup_review",
      runId: "55555555-5555-4555-8555-555555555555",
    });
    const declaration = minkReadToolRegistry
      .declarationsFor(actor)
      .find((tool) => tool.name === "start_delayed_pickup_review");
    expect(declaration?.parametersJsonSchema.properties).toEqual({
      location_name: expect.objectContaining({
        type: "string",
        maxLength: 100,
      }),
    });
  });

  it("queues the durable report only through its Analytics-gated tool", async () => {
    const actor = { ...ACTOR, runId: "run-1" };
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-workflow",
      name: "start_weekly_trading_report",
      args: {},
    });

    expect(mocks.enqueueWorkflow).toHaveBeenCalledWith(actor);
    expect(result.response.output).toMatchObject({
      workflow: { status: "queued", totalSteps: 3 },
    });
    expect(result.artifact).toEqual({
      type: "workflow",
      runId: "11111111-1111-4111-8111-111111111111",
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description:
        "A durable 7-day sales report compared with the previous period.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    });
  });

  it("returns bounded scope choices instead of silently aggregating a vague multi-location stock request", async () => {
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-1",
      name: "get_catalog_summary",
      args: { inventory_scope: "clarify" },
    });

    expect(mocks.readCatalog).not.toHaveBeenCalled();
    expect(mocks.readByLocation).not.toHaveBeenCalled();
    expect(result.response.output).toMatchObject({
      requiresClarification: true,
      question: expect.stringContaining("Which inventory scope"),
      choices: expect.arrayContaining([
        expect.objectContaining({ label: "Compare locations" }),
        expect.objectContaining({ label: "Combined stock" }),
        expect.objectContaining({ label: "Shop" }),
        expect.objectContaining({ label: "Delhi" }),
      ]),
    });
    expect(result.artifact).toMatchObject({
      type: "clarification",
      choices: expect.arrayContaining([
        expect.objectContaining({ label: "Compare locations" }),
      ]),
    });
  });

  it("automatically uses the only accessible location for a vague stock request", async () => {
    mocks.resolveLocation.mockResolvedValue({
      locationIds: ["shop-1"],
      selectedId: null,
      label: "1 assigned location",
      includeUnassigned: true,
      availableLocations: [{ id: "shop-1", name: "Shop", type: "shop" }],
    });

    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-2",
      name: "get_catalog_summary",
      args: { inventory_scope: "clarify", limit: 10 },
    });

    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        locationIds: ["shop-1"],
        includeInventory: true,
        limit: 10,
      }),
    );
  });

  it("compares only trusted accessible location ids for an explicit by-location request", async () => {
    mocks.readByLocation.mockResolvedValue({
      total: 14,
      published: 14,
      unpublished: 0,
      draft: 0,
      archived: 0,
      inventoryItems: 16,
      trackedItems: 9,
      locations: [
        {
          id: "shop-1",
          name: "Shop",
          type: "shop",
          inventoryItems: 16,
          trackedItems: 9,
          lowStock: 1,
          outOfStock: 2,
          dashboardPath: "/dashboard/inventory?location=shop-1",
        },
      ],
    });

    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-3",
      name: "get_catalog_summary",
      args: { inventory_scope: "by_location" },
    });

    expect(mocks.readByLocation).toHaveBeenCalledWith(
      expect.objectContaining({ locationIds: ["shop-1", "delhi-1"] }),
    );
    expect(result.artifact).toMatchObject({
      type: "catalog",
      locations: [
        expect.objectContaining({
          name: "Shop",
          lowStock: 1,
          outOfStock: 2,
        }),
      ],
    });
  });

  it("builds an explicit combined total from active accessible locations only", async () => {
    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-4",
      name: "get_catalog_summary",
      args: { inventory_scope: "combined" },
    });

    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        locationIds: ["shop-1", "delhi-1"],
        includeInventory: true,
      }),
    );
  });

  it("never resolves or exposes location choices without Inventory View", async () => {
    const result = await minkReadToolRegistry.execute(
      {
        ...ACTOR,
        isSuperadmin: false,
        permissions: { products: ["view"] },
      },
      {
        id: "call-5",
        name: "get_catalog_summary",
        args: { inventory_scope: "clarify" },
      },
    );

    expect(mocks.resolveLocation).not.toHaveBeenCalled();
    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ includeInventory: false, locationIds: [] }),
    );
    expect(result.response.output).toMatchObject({
      inventoryAccess: false,
      inventoryVisible: false,
      locationScope: "Inventory hidden by permission",
    });
    expect(result.artifact?.type).toBe("catalog");
  });

  it("exposes proposal tools only behind drafting opt-in, manage permission, and context", () => {
    const names = (overrides: Partial<MinkActorContext>) =>
      minkReadToolRegistry
        .declarationsFor({ ...ACTOR, isSuperadmin: false, ...overrides })
        .map((tool) => tool.name);

    expect(
      names({
        draftingEnabled: false,
        permissions: {
          products: ["manage"],
          blogs: ["manage"],
          marketing: ["manage"],
          users: ["manage"],
        },
      }).filter((name) => name.startsWith("propose_")),
    ).toEqual([]);

    expect(
      names({
        draftingEnabled: true,
        selectedResource: {
          type: "product",
          id: "11111111-1111-4111-8111-111111111111",
        },
        permissions: {
          products: ["manage"],
          blogs: ["manage"],
          marketing: ["manage"],
          users: ["manage"],
        },
      }).filter((name) => name.startsWith("propose_")),
    ).toEqual([
      "propose_product_images",
      "propose_current_product_description",
      "propose_current_product_seo",
      "propose_blog_draft",
      "propose_coupon_email",
      "propose_customer_message",
      "propose_social_posts",
      "propose_product_create",
      "propose_coupon_create",
      "propose_coupon_update",
      "propose_customer_group_create",
      "propose_customer_group_update",
      "propose_bulk_price_update",
    ]);
    expect(
      names({
        draftingEnabled: true,
        permissions: { categories: ["view", "manage"] },
      }),
    ).toEqual([
      "search_storefront_categories",
      "get_category_for_draft",
      "propose_category_create",
      "propose_category_update",
    ]);

    const marketingTools = names({
      draftingEnabled: true,
      permissions: { marketing: ["view", "manage"] },
    });
    expect(marketingTools.indexOf("get_coupon_for_draft")).toBeGreaterThan(-1);
    expect(marketingTools.indexOf("get_coupon_for_draft")).toBeLessThan(
      marketingTools.indexOf("propose_coupon_email"),
    );
    const couponReader = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { marketing: ["view", "manage"] },
      })
      .find((tool) => tool.name === "get_coupon_for_draft");
    expect(couponReader?.parametersJsonSchema).toMatchObject({
      required: ["coupon_code"],
      additionalProperties: false,
    });
    const customerTools = names({
      draftingEnabled: true,
      permissions: { users: ["view", "manage"] },
    });
    expect(
      customerTools.indexOf("get_customer_group_for_draft"),
    ).toBeGreaterThan(-1);
    expect(customerTools.indexOf("get_customer_group_for_draft")).toBeLessThan(
      customerTools.indexOf("propose_customer_group_update"),
    );
    const freeCustomerTools = names({
      draftingEnabled: true,
      effectivePlan: "free",
      permissions: { users: ["view", "manage"] },
    });
    expect(freeCustomerTools).not.toContain("propose_customer_group_create");
    expect(freeCustomerTools).toContain("propose_customer_group_update");

    const inventoryTools = names({
      draftingEnabled: true,
      permissions: { inventory: ["view", "manage"] },
    });
    expect(inventoryTools).toEqual([
      "list_low_stock",
      "get_inventory_item_for_adjustment",
      "propose_inventory_adjustment",
      "get_inventory_items_for_bulk_adjustment",
      "propose_bulk_inventory_adjustment",
    ]);
    const proposal = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "propose_inventory_adjustment");
    expect(proposal?.parametersJsonSchema).toMatchObject({
      required: expect.arrayContaining([
        "product_sku",
        "location_name",
        "inventory_snapshot",
        "reason",
      ]),
      additionalProperties: false,
    });
    expect(proposal?.parametersJsonSchema.properties).not.toHaveProperty(
      "product_id",
    );
    expect(proposal?.parametersJsonSchema.properties).not.toHaveProperty(
      "location_id",
    );
    expect(proposal?.parametersJsonSchema.properties).toHaveProperty(
      "quantity_change",
    );
    expect(proposal?.parametersJsonSchema.properties).toHaveProperty(
      "target_quantity",
    );
    const bulkReader = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "get_inventory_items_for_bulk_adjustment");
    const bulkProposal = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "propose_bulk_inventory_adjustment");
    expect(bulkReader?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: {
        lines: { minItems: 1, maxItems: 20 },
      },
    });
    expect(bulkProposal?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: {
        lines: { minItems: 1, maxItems: 20 },
      },
    });
    const bulkItems = (
      bulkProposal?.parametersJsonSchema.properties as {
        lines?: { items?: { properties?: Record<string, unknown> } };
      }
    )?.lines?.items?.properties;
    expect(bulkItems).not.toHaveProperty("product_id");
    expect(bulkItems).not.toHaveProperty("location_id");
    expect(bulkItems).toHaveProperty("inventory_snapshot");

    const productTools = minkReadToolRegistry.declarationsFor({
      ...ACTOR,
      isSuperadmin: false,
      draftingEnabled: true,
      permissions: { products: ["view", "manage"] },
    });
    const bulkPriceReader = productTools.find(
      (tool) => tool.name === "get_products_for_bulk_price_update",
    );
    const bulkPriceProposal = productTools.find(
      (tool) => tool.name === "propose_bulk_price_update",
    );
    expect(bulkPriceReader?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: { lines: { minItems: 1, maxItems: 20 } },
    });
    expect(bulkPriceProposal?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: { lines: { minItems: 1, maxItems: 20 } },
    });
    const bulkPriceItems = (
      bulkPriceProposal?.parametersJsonSchema.properties as {
        lines?: { items?: { properties?: Record<string, unknown> } };
      }
    )?.lines?.items?.properties;
    expect(bulkPriceItems).not.toHaveProperty("product_id");
    expect(bulkPriceItems).not.toHaveProperty("variant_id");
    expect(bulkPriceItems).toHaveProperty("price_snapshot");
    expect(bulkPriceItems).toHaveProperty("special_price_mode");
  });

  it("exposes complete Builder proposals only to a drafting actor with Manage", () => {
    const actor = {
      ...ACTOR,
      isSuperadmin: false,
      draftingEnabled: true,
      permissions: { builder: ["view", "manage"] },
    } as MinkActorContext;
    const names = (candidate: MinkActorContext) =>
      minkReadToolRegistry.declarationsFor(candidate).map((tool) => tool.name);
    expect(names(actor)).toContain("propose_website_builder_change");
    expect(
      names({ ...actor, permissions: { builder: ["view"] } }),
    ).not.toContain("propose_website_builder_change");
    expect(names({ ...actor, draftingEnabled: false })).not.toContain(
      "propose_website_builder_change",
    );
    expect(
      names({ ...actor, permissions: { dashboard: ["view"] } }),
    ).not.toContain("get_website_builder_context");
  });

  it("exposes and executes Phase 7B code proposals only with drafting and Builder Manage", async () => {
    const manageActor: MinkActorContext = {
      ...ACTOR,
      isSuperadmin: false,
      draftingEnabled: true,
      permissions: { builder: ["view", "manage"] },
    };
    const viewActor: MinkActorContext = {
      ...manageActor,
      permissions: { builder: ["view"] },
    };
    expect(
      minkReadToolRegistry
        .declarationsFor(manageActor)
        .map((tool) => tool.name),
    ).toContain("propose_storefront_custom_code");
    expect(
      minkReadToolRegistry.declarationsFor(viewActor).map((tool) => tool.name),
    ).not.toContain("propose_storefront_custom_code");
    expect(
      minkReadToolRegistry
        .declarationsFor({ ...manageActor, draftingEnabled: false })
        .map((tool) => tool.name),
    ).not.toContain("propose_storefront_custom_code");

    const result = await minkReadToolRegistry.execute(manageActor, {
      id: "call-code",
      name: "propose_storefront_custom_code",
      args: {
        page_slug: "home",
        section_id: "section-1",
        expected_page_version: "2026-09-04T10:20:30.123456+00:00",
        expected_section_digest: "a".repeat(64),
        html: "<section>Preview</section>",
        css: "section { padding: 2rem; }",
        js: "",
        height_mode: "auto",
        fixed_height: 480,
        explanation: "A responsive private preview.",
      },
    });
    expect(mocks.proposeStorefrontCode).toHaveBeenCalledWith({
      actor: manageActor,
      patch: expect.objectContaining({
        operation: "replace_custom_code",
        target: expect.objectContaining({
          pageSlug: "home",
          sectionId: "section-1",
        }),
      }),
      explanation: "A responsive private preview.",
    });
    expect(result.artifact).toMatchObject({
      type: "storefront_code_proposal",
      status: "private_preview",
    });
  });

  it("rejects direct calls to every hidden business tool before data access", async () => {
    const restricted: MinkActorContext = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { dashboard: ["view"] },
    };
    for (const name of [
      "get_catalog_summary",
      "search_storefront_categories",
      "search_products",
      "get_sales_summary",
      "list_low_stock",
      "start_weekly_trading_report",
      "start_delayed_pickup_review",
      "list_orders",
    ]) {
      await expect(
        minkReadToolRegistry.execute(restricted, { name, args: {} }),
      ).resolves.toMatchObject({
        response: { error: { code: "permission_denied" } },
      });
    }
  });
});

describe("takedown: what Mink's item reads say about a StoreMink block", () => {
  const TOLD = "11111111-1111-4111-8111-111111111111";
  const UNTOLD = "22222222-2222-4222-8222-222222222222";
  const PHOTO = "https://storage.googleapis.com/b/stores/store-1/media/p.webp";
  const OTHER = "https://storage.googleapis.com/b/stores/store-1/media/q.webp";
  const SENTENCE = (name: string) =>
    `StoreMink has blocked ${name}. It stays hidden from your store until StoreMink lifts the block. You can read why in Settings, Notices from StoreMink.`;

  beforeEach(() => {
    // TOLD is blocked and the store was told; UNTOLD is blocked under an
    // order that keeps it from the store, so blockedItemIds never returns it.
    mocks.marks = new Map([[TOLD, "33333333-3333-4333-8333-333333333333"]]);
    mocks.blockedSet = buildBlockedMediaSet(
      [
        {
          id: "44444444-4444-4444-8444-444444444444",
          objectPath: "stores/store-1/media/p.webp",
          fileSource: "bucket",
          storeId: "store-1",
          objectMd5: null,
          tellStore: false,
        },
      ],
      { bucket: "b", loadedAt: 1 },
    );
  });

  function product(id: string, name: string, imageUrl: string) {
    return {
      id,
      name,
      sku: "SKU1",
      status: "published",
      sellingPrice: 100,
      stock: 3,
      trackInventory: true,
      imageUrl,
      images: [imageUrl, OTHER],
      description: `<p><img src="${imageUrl}"></p>`,
      seoTitle: null,
      seoDescription: null,
    };
  }

  it("search_products marks a told block by name and leaves an untold one unmarked", async () => {
    mocks.selectRows = [
      product(TOLD, "Almond shake", OTHER),
      product(UNTOLD, "Cold coffee", OTHER),
    ];
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-search",
      name: "search_products",
      args: { query: "shake" },
    });
    const output = result.response.output as {
      products: Record<string, unknown>[];
    };
    expect(output.products[0]).toMatchObject({
      id: TOLD,
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Almond shake"),
    });
    // D21: nothing names or hints at a block kept from the store.
    expect(output.products[1]).not.toHaveProperty("blockedByStoreMink");
    expect(output.products[1]).not.toHaveProperty("storeMinkNotice");
    expect(JSON.stringify(output.products[1])).not.toMatch(/block/i);
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith(
      "store-1",
      "product",
    );
    // Read after the catalogue's scope: never inside its callback.
    expect(
      vi.mocked(blockedItemIds).mock.invocationCallOrder[0],
    ).toBeGreaterThan(vi.mocked(withUser).mock.invocationCallOrder[0]);
  });

  it("search_products hands a blocked photo over only as the placeholder", async () => {
    mocks.selectRows = [product(UNTOLD, "Cold coffee", PHOTO)];
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-search",
      name: "search_products",
      args: { query: "coffee" },
    });
    const output = result.response.output as {
      products: { imageUrl: string; images: string[] }[];
    };
    expect(output.products[0].imageUrl).toBe(PLACEHOLDER_URL_PATH);
    expect(output.products[0].images).toEqual([PLACEHOLDER_URL_PATH, OTHER]);
    expect(JSON.stringify(result.response)).not.toContain(PHOTO);
  });

  it("asks nothing about blocks when the search finds nothing", async () => {
    mocks.selectRows = [];
    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-search",
      name: "search_products",
      args: { query: "nothing" },
    });
    expect(vi.mocked(blockedItemIds)).not.toHaveBeenCalled();
  });

  it("get_current_product marks the open product and masks its pictures", async () => {
    mocks.selectRows = [product(TOLD, "Almond shake", PHOTO)];
    const actor = {
      ...ACTOR,
      draftingEnabled: true,
      selectedResource: { type: "product", id: TOLD },
    } as MinkActorContext;
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-current",
      name: "get_current_product",
      args: {},
    });
    const output = result.response.output as {
      products: Record<string, unknown>[];
    };
    expect(output.products[0]).toMatchObject({
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Almond shake"),
      imageUrl: PLACEHOLDER_URL_PATH,
    });
    expect(JSON.stringify(result.response)).not.toContain(PHOTO);
  });

  it("list_blogs marks a told post and masks a blocked cover", async () => {
    mocks.selectRows = [
      {
        id: TOLD,
        title: "Summer drinks",
        slug: "summer-drinks",
        excerpt: "",
        status: "published",
        featured: false,
        categories: [],
        tags: [],
        coverImageUrl: PHOTO,
        publishedAt: null,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ];
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-blogs",
      name: "list_blogs",
      args: {},
    });
    const output = result.response.output as {
      blogs: Record<string, unknown>[];
    };
    expect(output.blogs[0]).toMatchObject({
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Summer drinks"),
      coverImageUrl: PLACEHOLDER_URL_PATH,
    });
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith(
      "store-1",
      "blog_post",
    );
  });

  it("search_storefront_categories marks a told collection", async () => {
    mocks.selectRows = [
      {
        id: TOLD,
        name: "Shakes",
        slug: "shakes",
        description: null,
        status: "active",
        imageUrl: PHOTO,
      },
      {
        id: UNTOLD,
        name: "Coffee",
        slug: "coffee",
        description: null,
        status: "active",
        imageUrl: OTHER,
      },
    ];
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-categories",
      name: "search_storefront_categories",
      args: { query: "s" },
    });
    const output = result.response.output as {
      categories: Record<string, unknown>[];
    };
    expect(output.categories[0]).toMatchObject({
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Shakes"),
      imageUrl: PLACEHOLDER_URL_PATH,
    });
    expect(output.categories[1]).not.toHaveProperty("blockedByStoreMink");
    expect(output.categories[1]).toMatchObject({ imageUrl: OTHER });
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith(
      "store-1",
      "collection",
    );
  });

  // ★ Fix pass (must-do 34): the catalogue summary and the low-stock list name
  //   products too, so a told block is marked there as well; nothing new is
  //   read, only the existing mark lookup after the read's scope has closed.
  function healthItem(productId: string, productName: string, id = productId) {
    return {
      id,
      productId,
      variantId: id === productId ? null : id,
      productName,
      variantName: id === productId ? null : "Large",
      sku: "SKU1",
      publicationStatus: "published",
      publicationTags: [],
      stock: 1,
      threshold: 5,
      inventoryStatus: "low",
      dashboardPath: `/dashboard/products/${productId}`,
    };
  }

  it("get_catalog_summary marks a told-blocked product's rows and leaves an untold one unmarked", async () => {
    mocks.resolveLocation.mockResolvedValue({
      locationIds: ["shop-1"],
      selectedId: "shop-1",
      label: "Shop",
      includeUnassigned: false,
      availableLocations: [{ id: "shop-1", name: "Shop", type: "shop" }],
    });
    mocks.readCatalog.mockResolvedValue({
      total: 2,
      published: 2,
      unpublished: 0,
      draft: 0,
      archived: 0,
      inventoryItems: 3,
      lowStock: 3,
      outOfStock: 0,
      items: [
        healthItem(TOLD, "Almond shake"),
        healthItem(
          TOLD,
          "Almond shake",
          "55555555-5555-4555-8555-555555555555",
        ),
        healthItem(UNTOLD, "Cold coffee"),
      ],
      truncated: false,
    });
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-summary",
      name: "get_catalog_summary",
      args: { inventory_scope: "combined" },
    });
    const output = result.response.output as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(output.total).toBe(2);
    expect(output.items[0]).toMatchObject({
      productId: TOLD,
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Almond shake"),
    });
    expect(output.items[1]).toMatchObject({ blockedByStoreMink: true });
    // D21: nothing names or hints at a block kept from the store.
    expect(output.items[2]).not.toHaveProperty("blockedByStoreMink");
    expect(JSON.stringify(output.items[2])).not.toMatch(/block/i);
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith(
      "store-1",
      "product",
    );
    expect(
      vi.mocked(blockedItemIds).mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.readCatalog.mock.invocationCallOrder[0]);
  });

  it("get_catalog_summary asks nothing about blocks when it lists no product", async () => {
    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-summary",
      name: "get_catalog_summary",
      args: { inventory_scope: "publication_only" },
    });
    expect(vi.mocked(blockedItemIds)).not.toHaveBeenCalled();
  });

  it("list_low_stock marks a told-blocked product and leaves an untold one unmarked", async () => {
    mocks.readLowStock.mockResolvedValue({
      items: [
        {
          productId: TOLD,
          variantId: null,
          productName: "Almond shake",
          variantName: null,
          sku: "SKU1",
          stock: 1,
          threshold: 5,
          status: "low",
          productStatus: "published",
        },
        {
          productId: UNTOLD,
          variantId: null,
          productName: "Cold coffee",
          variantName: null,
          sku: "SKU2",
          stock: 0,
          threshold: 5,
          status: "out",
          productStatus: "published",
        },
      ],
      truncated: false,
    });
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-low",
      name: "list_low_stock",
      args: {},
    });
    const output = result.response.output as {
      items: Record<string, unknown>[];
      count: number;
    };
    expect(output.count).toBe(2);
    expect(output.items[0]).toMatchObject({
      productId: TOLD,
      productDashboardPath: `/dashboard/products/${TOLD}`,
      blockedByStoreMink: true,
      storeMinkNotice: SENTENCE("Almond shake"),
    });
    expect(output.items[1]).not.toHaveProperty("blockedByStoreMink");
    expect(JSON.stringify(output.items[1])).not.toMatch(/block/i);
    expect(vi.mocked(blockedItemIds)).toHaveBeenCalledWith(
      "store-1",
      "product",
    );
    expect(
      vi.mocked(blockedItemIds).mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.readLowStock.mock.invocationCallOrder[0]);
  });
});
