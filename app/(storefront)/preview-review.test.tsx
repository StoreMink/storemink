import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The storefront pages are server components: what is under test is which
// preview layers they mount, so every collaborator is a named stand-in and
// the returned element tree is read directly, with no DOM.
const stubs = vi.hoisted(() => {
  const named = (name: string) => {
    const Stub = () => null;
    Object.defineProperty(Stub, "name", { value: name });
    return Stub;
  };
  return {
    DraftCanvas: named("DraftCanvas"),
    PreviewBridge: named("PreviewBridge"),
    PreviewBadge: named("PreviewBadge"),
    BuilderOverlay: named("BuilderOverlay"),
    PageSectionRenderer: named("PageSectionRenderer"),
    StructuredData: named("StructuredData"),
  };
});

vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: async () => "store",
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: async () => ({
    name: "Crave",
    tagline: "Food",
    primaryColor: "#E8A427",
  }),
}));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedPage: vi.fn(async () => null),
}));
vi.mock("@/lib/pages/preview", () => ({
  getDraftPageForPreview: vi.fn(async (_store: string, slug: string) => ({
    id: "page",
    slug,
    title: slug || "Home",
    seo_title: "",
    seo_description: "",
    sections: [],
  })),
}));
vi.mock("@/lib/sections/resolve-data", () => ({
  fetchSectionDatasets: async () => ({
    products: [],
    categories: [],
    blogs: [],
  }),
  resolveSectionData: async () => ({}),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSetting: async () => false,
}));
vi.mock("./components/sections/draft-canvas", () => ({
  DraftCanvas: stubs.DraftCanvas,
}));
vi.mock("./components/sections/preview-bridge", () => ({
  PreviewBridge: stubs.PreviewBridge,
  PreviewBadge: stubs.PreviewBadge,
}));
vi.mock("./components/sections/builder-overlay", () => ({
  BuilderOverlay: stubs.BuilderOverlay,
}));
vi.mock("./components/sections/page-section-renderer", () => ({
  PageSectionRenderer: stubs.PageSectionRenderer,
}));
vi.mock("./components/structured-data", () => ({
  default: stubs.StructuredData,
}));

import Home from "./page";
import StorePage from "./(pages)/[pageSlug]/page";

/** The names of every component in an element tree. */
function mounted(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(mounted);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const own = typeof element.type === "function" ? [element.type.name] : [];
  return [...own, ...mounted(element.props.children)];
}

async function home(searchParams: Record<string, string>) {
  return mounted(await Home({ searchParams: Promise.resolve(searchParams) }));
}

async function page(searchParams: Record<string, string>) {
  return mounted(
    await StorePage({
      params: Promise.resolve({ pageSlug: "about" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the storefront preview layers", () => {
  it("keeps the Builder's edit layer and badge in the Builder's own preview", async () => {
    for (const layers of [
      await home({ preview: "1" }),
      await page({ preview: "1" }),
    ]) {
      expect(layers).toEqual(
        expect.arrayContaining([
          "DraftCanvas",
          "PreviewBridge",
          "PreviewBadge",
          "BuilderOverlay",
        ]),
      );
    }
  });

  it("★★ a review preview draws the draft with no edit controls over it", async () => {
    for (const layers of [
      await home({ preview: "1", review: "1" }),
      await page({ preview: "1", review: "1" }),
    ]) {
      // The canvas and its handshake stay: the revamp preview sends the
      // proposed sections through them.
      expect(layers).toEqual(
        expect.arrayContaining(["DraftCanvas", "PreviewBridge"]),
      );
      expect(layers).not.toContain("BuilderOverlay");
      expect(layers).not.toContain("PreviewBadge");
    }
  });
});
