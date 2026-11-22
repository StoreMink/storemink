// @vitest-environment jsdom
// The built-in "Our stores" and "Saved items" pages, and the rule that a
// merchant's own page at the same address always wins.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  layout: { storeLocator: true, wishlist: true },
  shops: [] as unknown[],
  published: null as unknown,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({ name: "Clay", primaryColor: "#111111" })),
}));
vi.mock("@/lib/store/storefront-layout", () => ({
  getStorefrontLayout: vi.fn(async () => h.layout),
}));
vi.mock("@/lib/storefront/store-locations", () => ({
  getPublicShopLocations: vi.fn(async () => h.shops),
}));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedPage: vi.fn(async () => h.published),
}));
vi.mock("@/lib/pages/preview", () => ({
  getDraftPageForPreview: vi.fn(async () => null),
}));
vi.mock("@/lib/sections/resolve-data", () => ({
  fetchSectionDatasets: vi.fn(async () => ({})),
  resolveSectionData: vi.fn(async () => ({})),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSetting: vi.fn(async () => false),
}));
vi.mock("@/app/(storefront)/components/sections/page-section-renderer", () => ({
  PageSectionRenderer: () => <div data-testid="merchant-page" />,
}));
vi.mock("@/app/(storefront)/components/sections/draft-canvas", () => ({
  DraftCanvas: () => null,
}));
vi.mock("@/app/(storefront)/components/sections/preview-bridge", () => ({
  PreviewBridge: () => null,
  PreviewBadge: () => null,
}));
vi.mock("@/app/(storefront)/components/sections/builder-overlay", () => ({
  BuilderOverlay: () => null,
}));
vi.mock("@/app/(storefront)/components/saved-products", () => ({
  SavedProducts: () => <div data-testid="saved" />,
}));

import StorePage, { generateMetadata } from "./page";
import { BUILT_IN_PAGE_SLUGS, builtInPage } from "./built-in";
import { getPublicShopLocations } from "@/lib/storefront/store-locations";
import { RESERVED_PAGE_SLUGS } from "@/lib/sections/registry";

const shop = (id: string, name: string) => ({
  id,
  name,
  address: ["12 Radial Road", "Bengaluru, Karnataka, 560038"],
  mapsUrl: `https://www.google.com/maps/search/?api=1&query=${id}`,
});
const at = (pageSlug: string) => ({
  params: Promise.resolve({ pageSlug }),
  searchParams: Promise.resolve({}),
});

beforeEach(() => {
  h.layout = { storeLocator: true, wishlist: true };
  h.shops = [shop("a", "Indiranagar shop"), shop("b", "Koramangala shop")];
  h.published = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("★★ a merchant's own page always wins", () => {
  it("their page at /stores is rendered, and the built-in one is never read", async () => {
    h.published = {
      slug: "stores",
      title: "Our studios",
      published_sections: [],
    };
    render(await StorePage(at("stores")));
    expect(screen.getByTestId("merchant-page")).toBeTruthy();
    expect(screen.queryByText("Get directions")).toBeNull();
    expect(getPublicShopLocations).not.toHaveBeenCalled();
    expect((await generateMetadata(at("stores"))).title).toBe("Our studios");
  });

  it("neither address is reserved: the list every Theme Studio prompt prints is unchanged", () => {
    for (const slug of BUILT_IN_PAGE_SLUGS)
      expect(RESERVED_PAGE_SLUGS.has(slug), slug).toBe(false);
  });
});

describe("the Our stores page", () => {
  it("lists each shop with its address and a directions link that opens safely", async () => {
    render(await StorePage(at("stores")));
    expect(
      screen.getByRole("heading", { level: 1, name: "Our stores" }),
    ).toBeTruthy();
    expect(screen.getByText("Visit us at any of our 2 shops.")).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h2) => h2.textContent),
    ).toEqual(["Indiranagar shop", "Koramangala shop"]);
    const link = screen.getAllByRole("link")[0];
    expect(link.getAttribute("href")).toContain("google.com/maps/search");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("to Indiranagar shop");
    expect(getPublicShopLocations).toHaveBeenCalledWith("store-1");
    expect(await generateMetadata(at("stores"))).toMatchObject({
      title: "Our stores",
      alternates: { canonical: "/stores" },
    });
  });

  it("★ is a 404 for a store with no shop, or whose merchant switched it off", async () => {
    h.shops = [];
    await expect(StorePage(at("stores"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata(at("stores"))).toEqual({});
    h.shops = [shop("a", "Indiranagar shop")];
    h.layout = { storeLocator: false, wishlist: true };
    vi.clearAllMocks();
    await expect(StorePage(at("stores"))).rejects.toThrow("NEXT_NOT_FOUND");
    // Switched off, the locations are not even read.
    expect(getPublicShopLocations).not.toHaveBeenCalled();
  });

  it("one shop reads as one", async () => {
    h.shops = [shop("a", "Indiranagar shop")];
    render(await StorePage(at("stores")));
    expect(screen.getByText("Visit us at our shop.")).toBeTruthy();
  });
});

describe("the Saved items page", () => {
  it("renders the shopper's list, and is never indexed", async () => {
    render(await StorePage(at("wishlist")));
    expect(screen.getByTestId("saved")).toBeTruthy();
    expect(await generateMetadata(at("wishlist"))).toMatchObject({
      title: "Saved items",
      robots: { index: false },
    });
  });

  it("★ is a 404 where the merchant switched the wishlist off", async () => {
    h.layout = { storeLocator: true, wishlist: false };
    await expect(StorePage(at("wishlist"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("any other unknown address", () => {
  it("is still a 404, and reads nothing", async () => {
    expect(await builtInPage("anything-else", "store-1")).toBeNull();
    await expect(StorePage(at("anything-else"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(getPublicShopLocations).not.toHaveBeenCalled();
  });
});
