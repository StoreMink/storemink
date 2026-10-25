// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SectionDatasets } from "@/lib/sections/map-data";

// The canvas is what is under test, not the seventeen section renderers: this
// stand-in lists the product names the canvas resolved for each section.
vi.mock("./page-section-renderer", async () => {
  const { createElement } = await import("react");
  return {
    PageSectionRenderer: ({
      resolved,
    }: {
      resolved: {
        productsBySection: Map<string, Array<{ id: string; name: string }>>;
      };
    }) =>
      createElement(
        "ul",
        null,
        [...resolved.productsBySection.values()]
          .flat()
          .map((product) =>
            createElement("li", { key: product.id }, product.name),
          ),
      ),
  };
});

import {
  DraftCanvas,
  MAX_DRAFT_PRODUCTS,
  mergeDatasets,
  readDraftDatasets,
} from "./draft-canvas";

const SECTIONS = [
  {
    id: "featured",
    type: "featured_products",
    enabled: true,
    config: {
      source: "featured",
      limit: 4,
      product_ids: [],
      category_id: null,
      title: "Featured",
    },
  },
] as never;

function product(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    slug: id,
    image_url: null,
    base_price: 500,
    selling_price: 450,
    featured: true,
    category: null,
    category_id: null,
    track_inventory: false,
    stock: 0,
    low_stock_threshold: null,
    allow_backorder: false,
    ...extra,
  };
}

const BASE: SectionDatasets = {
  products: [product("old", "Old sample")],
  categories: [],
  blogs: [],
};

function send(
  data: unknown,
  options: { origin?: string; source?: unknown } = {},
) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", {
    value: options.origin ?? window.location.origin,
  });
  Object.defineProperty(event, "source", {
    value: "source" in options ? options.source : window.parent,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("readDraftDatasets", () => {
  it("rebuilds each product from known fields and drops the unsafe ones", () => {
    const parsed = readDraftDatasets({
      products: [
        product("new", "Amber candle", {
          image_url: "https://storage.googleapis.com/media/amber.webp",
          variants: [{ selling_price: 1 }],
          evil: "<script>",
        }),
        product("js", "Bad link", { image_url: "javascript:alert(1)" }),
        product("proto", "Other host", { image_url: "//evil.example/x.png" }),
        product("nan", "No price", { selling_price: Number.NaN }),
        { id: "nameless", slug: "nameless" },
      ],
    });
    expect(parsed?.products).toEqual([
      product("new", "Amber candle", {
        image_url: "https://storage.googleapis.com/media/amber.webp",
      }),
    ]);
    expect(parsed?.products?.[0]).not.toHaveProperty("variants");
  });

  it("ignores a list that is not a list or is too long, and returns null for junk", () => {
    expect(readDraftDatasets({ products: "nope" })).toBeNull();
    expect(
      readDraftDatasets({
        products: Array.from({ length: MAX_DRAFT_PRODUCTS + 1 }, (_, i) =>
          product(`p${i}`, `Product ${i}`),
        ),
      }),
    ).toBeNull();
    expect(readDraftDatasets(null)).toBeNull();
    expect(readDraftDatasets([product("a", "A")])).toBeNull();
    expect(
      readDraftDatasets({
        categories: [
          { id: "c", name: "Candles", slug: "candles", image_url: null },
        ],
      }),
    ).toEqual({
      categories: [
        {
          id: "c",
          name: "Candles",
          slug: "candles",
          image_url: null,
          description: null,
        },
      ],
    });
  });
});

describe("mergeDatasets", () => {
  it("puts the message's entries first and replaces the ones with the same id", () => {
    const merged = mergeDatasets(
      {
        ...BASE,
        products: [product("old", "Old sample"), product("kept", "Kept")],
      },
      { products: [product("old", "Renamed"), product("new", "New")] },
    );
    expect(merged.products.map((p) => p.name)).toEqual([
      "Renamed",
      "New",
      "Kept",
    ]);
    expect(mergeDatasets(BASE, null)).toBe(BASE);
  });
});

describe("what goes live at Apply, drawn in the preview", () => {
  const category = (id: string, name: string) => ({
    id,
    name,
    slug: id,
    image_url: null,
    description: null,
  });

  it("★ reads the ids to take off the shop, bounded, and keeps only strings", () => {
    expect(
      readDraftDatasets({
        hiddenProductIds: ["sample-1", 7, "", "sample-2"],
        hiddenCategoryIds: ["dairy"],
      }),
    ).toEqual({
      hiddenProductIds: ["sample-1", "sample-2"],
      hiddenCategoryIds: ["dairy"],
    });
    expect(
      readDraftDatasets({
        hiddenProductIds: Array.from(
          { length: MAX_DRAFT_PRODUCTS + 1 },
          (_, i) => `p${i}`,
        ),
      }),
    ).toBeNull();
  });

  it("★★ drops the samples Apply hides and redraws the categories in place, never merged beside the old ones", () => {
    const merged = mergeDatasets(
      {
        products: [
          product("sample-1", "Apples (Sample)"),
          product("own", "Own"),
        ],
        categories: [
          category("fruit", "Fruit"),
          category("dairy", "Dairy"),
          category("bakery", "Bakery"),
        ],
        blogs: [],
      },
      {
        products: [product("revamp-mango", "Mango pickle")],
        categories: [
          category("fruit", "Seeds"),
          category("revamp-category-oils", "Oils"),
        ],
        hiddenProductIds: ["sample-1"],
        hiddenCategoryIds: ["dairy"],
      },
    );
    expect(merged.products.map((p) => p.name)).toEqual(["Mango pickle", "Own"]);
    expect(merged.categories.map((c) => c.name)).toEqual([
      "Seeds",
      "Bakery",
      "Oils",
    ]);
  });

  it("★ takes the samples off even when the redesign brings no products of its own", () => {
    // A plan may hide the theme's samples while the merchant adds nothing yet:
    // the preview then sends an empty products list beside the hidden ids.
    const base: SectionDatasets = {
      ...BASE,
      products: [product("sample-1", "Apples (Sample)"), product("own", "Own")],
    };
    expect(
      mergeDatasets(base, { hiddenProductIds: ["sample-1"] }).products.map(
        (p) => p.name,
      ),
    ).toEqual(["Own"]);
    render(<DraftCanvas initialSections={SECTIONS} datasets={base} />);
    send({
      type: "sm-draft",
      sections: SECTIONS,
      datasets: { products: [], hiddenProductIds: ["sample-1"] },
    });
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["Own"],
    );
  });

  it("shows the canvas without a sample the message hides", () => {
    render(
      <DraftCanvas
        initialSections={SECTIONS}
        datasets={{
          ...BASE,
          products: [product("sample-1", "Apples (Sample)")],
        }}
      />,
    );
    expect(screen.getByText("Apples (Sample)")).toBeInTheDocument();
    send({
      type: "sm-draft",
      sections: SECTIONS,
      datasets: {
        products: [product("new", "Amber candle")],
        hiddenProductIds: ["sample-1"],
      },
    });
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["Amber candle"],
    );
  });
});

describe("DraftCanvas", () => {
  it("shows products a draft message brings, merged over its own snapshot", () => {
    render(<DraftCanvas initialSections={SECTIONS} datasets={BASE} />);
    expect(screen.getByText("Old sample")).toBeInTheDocument();
    send({
      type: "sm-draft",
      sections: SECTIONS,
      datasets: { products: [product("new", "Amber candle")] },
    });
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["Amber candle", "Old sample"],
    );
  });

  it("ignores another origin, and takes data only from the frame that embeds it", () => {
    render(<DraftCanvas initialSections={SECTIONS} datasets={BASE} />);
    send(
      {
        type: "sm-draft",
        sections: SECTIONS,
        datasets: { products: [product("x", "From elsewhere")] },
      },
      { origin: "https://evil.example" },
    );
    expect(screen.queryByText("From elsewhere")).toBeNull();
    send(
      {
        type: "sm-draft",
        sections: SECTIONS,
        datasets: { products: [product("y", "Not the parent")] },
      },
      { source: null },
    );
    expect(screen.queryByText("Not the parent")).toBeNull();
    expect(screen.getByText("Old sample")).toBeInTheDocument();
  });
});
