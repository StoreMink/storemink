import { beforeEach, describe, expect, it, vi } from "vitest";
const insertValues = vi.fn();
const onConflictDoNothing = vi.fn(async () => undefined);
const insert = vi.fn(() => ({
  values: insertValues.mockReturnValue({ onConflictDoNothing }),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => Promise<unknown>) =>
    fn({ insert }),
  ),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => ({
    id: "156c8c4f-4aae-4bff-8f29-4ac24d4805f5",
    plan: "pro",
    settings: {},
  })),
}));
vi.mock("@/lib/analytics/platform-feature-store", () => ({
  getPlatformAnalyticsFeatures: vi.fn(async () => ({
    coreDashboard: true,
    dashboardCustomization: true,
    drilldownReports: true,
    googleSearchConsole: true,
    googleAnalytics4: false,
    metaPixel: false,
    storefrontConversion: true,
    grossMargin: false,
  })),
}));
vi.mock("@/lib/analytics/storefront-identity", () => ({
  storefrontVisitorIdentity: vi.fn(() => ({
    visitorKey: "1234567890abcdef1234567890abcdef",
    eventDate: "2026-08-20",
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { POST } from "./route";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

function request(
  body: unknown,
  origin = "https://mystore.storemink.com",
  extraHeaders: Record<string, string> = {},
) {
  return new Request("https://mystore.storemink.com/api/t", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "mystore.storemink.com",
      origin,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/t", () => {
  it("accepts an eligible, same-origin browser event idempotently", async () => {
    const response = await POST(
      request({
        eventId: "7bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
        type: "page_view",
        path: "/shop",
      }),
    );
    expect(response.status).toBe(204);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "156c8c4f-4aae-4bff-8f29-4ac24d4805f5",
        eventType: "page_view",
      }),
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it("never accepts a browser-declared purchase", async () => {
    const response = await POST(
      request({
        eventId: "7bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
        type: "purchase",
      }),
    );
    expect(response.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    const response = await POST(
      request(
        {
          eventId: "7bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
          type: "page_view",
        },
        "https://attacker.example",
      ),
    );
    expect(response.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });

  it("silently disables collection below Pro", async () => {
    vi.mocked(getCurrentStoreOrNull).mockResolvedValueOnce({
      id: "156c8c4f-4aae-4bff-8f29-4ac24d4805f5",
      name: "Test",
      slug: "test",
      plan: "basic",
      plan_expires_at: null,
      status: "active",
      custom_domain: null,
      settings: {},
    } as never);
    const response = await POST(
      request({
        eventId: "7bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
        type: "page_view",
      }),
    );
    expect(response.status).toBe(204);
    expect(insert).not.toHaveBeenCalled();
  });

  it("stores derived attribution, never the raw user agent or referring URL", async () => {
    await POST(
      request(
        {
          eventId: "8bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
          type: "page_view",
          path: "/",
          referrer: "https://l.instagram.com/?u=https%3A%2F%2Fmystore&e=secret",
          utm: {
            source: "instagram",
            medium: "social",
            campaign: " Diwali Sale ",
          },
        },
        "https://mystore.storemink.com",
        {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
          "x-sm-geo-country": "IN",
          "x-sm-geo-region": "INMH",
          "x-sm-geo-city": "Mumbai",
        },
      ),
    );
    const row = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      deviceType: "mobile",
      source: "social",
      referrerHost: "instagram.com",
      utmCampaign: "Diwali Sale",
      country: "IN",
      region: "MH",
      city: "Mumbai",
    });
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(JSON.stringify(row)).not.toContain("iPhone");
  });

  it("treats the store's own pages as no referrer (direct)", async () => {
    await POST(
      request({
        eventId: "9bf13763-9e50-4d42-9e8a-0b79fe84b7c1",
        type: "page_view",
        path: "/shop",
        referrer: "https://mystore.storemink.com/",
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        referrerHost: null,
        source: "direct",
        country: null,
      }),
    );
  });
});
