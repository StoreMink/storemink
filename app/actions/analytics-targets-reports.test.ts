/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const entitlements = vi.hoisted(() => ({
  dashboardCustomization: true,
  drilldownReports: true,
  storefrontConversion: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));
vi.mock("@/lib/analytics/store-entitlement", () => ({
  storeHasAnalyticsFeature: vi.fn(
    async (_store: string, feature: keyof typeof entitlements) =>
      entitlements[feature] ?? false,
  ),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getViewerContext } from "@/app/dashboard/lib/access";
import {
  deleteAnalyticsTarget,
  saveAnalyticsTarget,
} from "./analytics-targets";
import { saveAnalyticsReport } from "./analytics-reports";

const OWNER = {
  userId: "user-1",
  profile: { role: "superadmin" },
  isSuperadmin: true,
  permissions: {},
  storeId: "store-1",
};
const VIEW_ONLY_STAFF = {
  ...OWNER,
  profile: { role: "staff" },
  isSuperadmin: false,
  permissions: { analytics: ["view"] },
};

const october = {
  metric: "total_sales",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  targetValue: 100000,
};

beforeEach(() => {
  vi.clearAllMocks();
  entitlements.dashboardCustomization = true;
  entitlements.drilldownReports = true;
  entitlements.storefrontConversion = false;
  dbHolder.current = makeDbMock({ selectQueue: [[{ total: 0 }]] });
  vi.mocked(getViewerContext).mockResolvedValue(OWNER as any);
});

describe("analytics targets actions", () => {
  it("creates a store-scoped target for someone who can manage Analytics", async () => {
    expect(await saveAnalyticsTarget(october)).toEqual({ success: true });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      metric: "total_sales",
      targetValue: "100000",
      createdBy: "user-1",
    });
  });

  it("refuses staff who can only view Analytics", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(VIEW_ONLY_STAFF as any);
    expect((await saveAnalyticsTarget(october)).error).toMatch(/permission/);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("keeps targets on Basic and above, and traffic targets on Pro", async () => {
    expect(
      (await saveAnalyticsTarget({ ...october, metric: "sessions" })).error,
    ).toBe("Storefront traffic targets need the Pro plan.");
    entitlements.dashboardCustomization = false;
    expect((await saveAnalyticsTarget(october)).error).toBe(
      "Targets are available on Basic and Pro.",
    );
  });

  it("caps a store at twenty targets", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ total: 20 }]] });
    expect((await saveAnalyticsTarget(october)).error).toMatch(/up to 20/);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects a malformed id before it reaches the database", async () => {
    expect(
      (await saveAnalyticsTarget({ ...october, id: "1; drop table" })).error,
    ).toBe("That target isn't valid.");
    expect((await deleteAnalyticsTarget("nope")).error).toBe(
      "That target isn't valid.",
    );
    expect(dbHolder.current.calls.delete).toHaveLength(0);
  });
});

describe("saved report actions", () => {
  it("stores the normalized config, never what the client sent", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ total: 0 }]],
      returning: [{ id: "5e0a3f0e-8a6c-4c0a-9d43-1f0d0d2b8a11" }],
    });
    const result = await saveAnalyticsReport({
      name: "  By product  ",
      config: {
        dataset: "traffic",
        dimension: "product",
        metrics: ["shipping", "units", "nonsense"],
        chart: "pie",
      },
    });
    expect(result.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      name: "By product",
      // Traffic is Pro-only here, product groups order lines, so only units
      // survives, and an unknown chart falls back to the grouping's default.
      config: {
        dataset: "sales",
        dimension: "product",
        metrics: ["units"],
        chart: "bar",
      },
    });
  });

  it("needs the reports entitlement and a name", async () => {
    expect(
      (await saveAnalyticsReport({ name: " ", config: {} })).error,
    ).toMatch(/name/);
    entitlements.drilldownReports = false;
    expect(
      (await saveAnalyticsReport({ name: "Sales", config: {} })).error,
    ).toBe("Custom reports are available on Basic and Pro.");
  });
});
