/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Media page reads which files StoreMink blocked and told the store about
// (takedown design 7.3) and hands them to the grid keyed by the address each
// tile shows. A file block is keyed by its media key (the object path for a
// file in the store's bucket, the address for one elsewhere), so the page
// turns each tile's address into that key. A block kept from the store never
// reaches it (D21), and a failed read marks nothing.

const BUCKET = "sm-media";
const ours = (path: string) =>
  `https://storage.googleapis.com/${BUCKET}/${path}`;

const H = vi.hoisted(() => ({
  canSettings: true,
  canProducts: true,
  assets: [] as Record<string, unknown>[],
  images: [] as Record<string, unknown>[],
}));

vi.mock("../lib/access", () => ({
  requireSectionAccess: vi.fn(async () => ({
    can: (section: string) =>
      section === "settings"
        ? H.canSettings
        : section === "products"
          ? H.canProducts
          : true,
  })),
  getActingStoreId: vi.fn(async () => "s1"),
}));
vi.mock("@/lib/media/library", () => ({
  listLibraryAssets: vi.fn(async () => ({
    assets: H.assets,
    total: H.assets.length,
  })),
  countLibraryAssets: vi.fn(async () => H.assets.length),
}));
vi.mock("@/lib/media/product-images", () => ({
  productImageUsage: vi.fn(async () => new Map()),
  countProductImages: vi.fn(async () => H.images.length),
  listProductImages: vi.fn(async () => ({
    items: H.images,
    total: H.images.length,
  })),
}));
vi.mock("@/lib/storage/gcs", () => ({ GCS_BUCKET_NAME: "sm-media" }));
vi.mock("@/lib/moderation/merchant", () => ({
  blockedItemIds: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("./media-library-view", () => ({
  MediaLibraryView: vi.fn(() => null),
}));

import { blockedItemIds } from "@/lib/moderation/merchant";
import { listLibraryAssets } from "@/lib/media/library";
import { productImageUsage } from "@/lib/media/product-images";
import MediaDashboardPage from "./page";

function asset(id: string, url: string, path: string): Record<string, unknown> {
  return {
    id,
    url,
    path,
    filename: `${id}.webp`,
    content_type: "image/webp",
    size_bytes: 100,
    source: "upload",
    created_at: "2026-10-01T00:00:00Z",
  };
}

async function viewProps(
  sp: Record<string, string> = {},
): Promise<Record<string, any>> {
  const el = (await MediaDashboardPage({
    searchParams: Promise.resolve(sp),
  })) as any;
  return el.props as Record<string, any>;
}

beforeEach(() => {
  H.canSettings = true;
  H.canProducts = true;
  H.assets = [
    asset("a", ours("stores/s1/media/a.webp"), "stores/s1/media/a.webp"),
    asset("b", ours("stores/s1/media/b.webp"), "stores/s1/media/b.webp"),
  ];
  H.images = [];
});

describe("Media page and files blocked by StoreMink", () => {
  it("reads the store's blocked files once and marks the tile by its address", async () => {
    vi.mocked(blockedItemIds).mockResolvedValueOnce(
      new Map([["stores/s1/media/a.webp", "blk-a"]]),
    );
    const props = await viewProps();

    expect(blockedItemIds).toHaveBeenCalledTimes(1);
    expect(blockedItemIds).toHaveBeenCalledWith("s1", "file");
    // Read after the list's own reads have finished.
    const read = vi.mocked(blockedItemIds).mock.invocationCallOrder[0];
    expect(
      vi.mocked(listLibraryAssets).mock.invocationCallOrder[0],
    ).toBeLessThan(read);
    expect(
      vi.mocked(productImageUsage).mock.invocationCallOrder[0],
    ).toBeLessThan(read);
    // ★ Only the told block: b is listed and not marked.
    expect(props.blockedByStoreMink).toEqual({
      [ours("stores/s1/media/a.webp")]: "blk-a",
    });
    expect(props.assets).toHaveLength(2);
    expect(props.canSeeNotices).toBe(true);
  });

  it("marks a file kept by its object path when its address reads differently", async () => {
    // An address the media key cannot read is still matched by the path the
    // library row stores.
    H.assets = [asset("c", "not a url", "stores/s1/media/c.webp")];
    vi.mocked(blockedItemIds).mockResolvedValueOnce(
      new Map([["stores/s1/media/c.webp", "blk-c"]]),
    );
    const props = await viewProps();

    expect(props.blockedByStoreMink).toEqual({ "not a url": "blk-c" });
  });

  it("marks a product photo on another host by its address", async () => {
    H.images = [
      { url: "https://cdn.example.com/p/1.jpg?w=400", products: [] },
      { url: ours("stores/s1/products/2.webp"), products: [] },
    ];
    vi.mocked(blockedItemIds).mockResolvedValueOnce(
      new Map([["https://cdn.example.com/p/1.jpg", "blk-ext"]]),
    );
    const props = await viewProps({ tab: "products" });

    expect(props.tab).toBe("products");
    expect(props.blockedByStoreMink).toEqual({
      "https://cdn.example.com/p/1.jpg?w=400": "blk-ext",
    });
  });

  it("a failed read marks nothing and the grid still loads", async () => {
    vi.mocked(blockedItemIds).mockRejectedValueOnce(new Error("db down"));
    const props = await viewProps();

    expect(props.blockedByStoreMink).toEqual({});
    expect(props.assets).toHaveLength(2);
    expect(props.loadError).toBe(false);
  });

  it("an empty grid asks nothing", async () => {
    H.assets = [];
    const props = await viewProps();

    expect(blockedItemIds).not.toHaveBeenCalled();
    expect(props.blockedByStoreMink).toEqual({});
  });

  it("no See why for an admin who cannot open the notices", async () => {
    H.canSettings = false;
    const props = await viewProps();

    expect(props.canSeeNotices).toBe(false);
  });
});
