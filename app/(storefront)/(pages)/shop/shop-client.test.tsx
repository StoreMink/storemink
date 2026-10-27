// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));
vi.mock("@/app/(storefront)/components/brand-provider", () => ({
  useBrand: () => ({ name: "Test Store", tagline: "", blurb: "" }),
}));
vi.mock("@/app/(storefront)/components/shop-card", () => ({
  ShopCard: ({ product }: { product: { name: string } }) => (
    <article data-testid="card">{product.name}</article>
  ),
}));

import ShopClient, { type ShopCategory, type ShopProduct } from "./shop-client";
import { DEFAULT_SHOP_QUERY } from "@/lib/storefront/shop-filters";

function product(
  id: string,
  name: string,
  price: number,
  over: Partial<ShopProduct> = {},
): ShopProduct {
  return {
    id,
    name,
    slug: id,
    description: null,
    category_id: "c1",
    base_price: price,
    selling_price: price,
    image_url: null,
    featured: false,
    sort_order: 0,
    card_color: null,
    created_at: "2026-01-01T00:00:00Z",
    track_inventory: false,
    stock: 0,
    low_stock_threshold: null,
    allow_backorder: false,
    variants: [],
    ...over,
  };
}

const categories: ShopCategory[] = [
  {
    id: "c1",
    name: "Juices",
    slug: "juices",
    sort_order: 0,
    description: "Cold-pressed every morning.",
    image_url: "/juices.webp",
  },
  { id: "c2", name: "Snacks", slug: "snacks", sort_order: 1 },
];

const products = [
  product("mango", "Mango", 300),
  product("apple", "Apple", 100, {
    track_inventory: true,
    stock: 0,
  }),
  product("chips", "Chips", 200, {
    category_id: "c2",
    created_at: "2026-05-01T00:00:00Z",
  }),
];

const names = () => screen.queryAllByTestId("card").map((c) => c.textContent);

let replaceState: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.history.pushState({}, "", "/shop");
  replaceState = vi.spyOn(window.history, "replaceState");
});
afterEach(() => {
  replaceState.mockRestore();
});

const lastUrl = () =>
  String(replaceState.mock.calls[replaceState.mock.calls.length - 1]?.[2]);

describe("ShopClient with shared shopping controls by default", () => {
  it("shows filters and sorting without requiring a theme opt-in", () => {
    render(<ShopClient products={products} categories={categories} />);
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    expect(screen.getByRole("combobox", { name: /sort/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^filter/i })).toBeTruthy();
    expect(screen.getByText("Showing 3 of 3 products")).toBeTruthy();
  });

  it("applies shared-link sorting and filters without a theme opt-in", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        initialShop={{
          ...DEFAULT_SHOP_QUERY,
          sort: "price-asc",
          inStock: true,
        }}
      />,
    );
    expect(names()).toEqual(["Chips", "Mango"]);
    expect(screen.getByRole("button", { name: /^in stock/i })).toBeTruthy();
  });

  it("links each category chip to its own page", () => {
    render(<ShopClient products={products} categories={categories} />);
    const nav = screen.getByRole("navigation", { name: "Categories" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/shop",
      "/collections/juices",
      "/collections/snacks",
    ]);
    expect(within(nav).getByRole("link", { name: "All" })).toHaveProperty(
      "ariaCurrent",
      "page",
    );
  });
});

describe("ShopClient filtering, sorting and pagination", () => {
  const renderShop = (extra: Partial<Parameters<typeof ShopClient>[0]> = {}) =>
    render(
      <ShopClient products={products} categories={categories} {...extra} />,
    );

  it("sorts in place and writes the sort into the URL", () => {
    renderShop();
    fireEvent.change(screen.getByRole("combobox", { name: /sort by/i }), {
      target: { value: "price-asc" },
    });
    expect(names()).toEqual(["Apple", "Chips", "Mango"]);
    expect(lastUrl()).toBe("/shop?sort=price-asc");
  });

  it("opens with the view the URL describes", () => {
    renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, sort: "newest", inStock: true },
    });
    expect(names()).toEqual(["Chips", "Mango"]);
    expect(screen.getByRole("button", { name: /in stock/i })).toBeTruthy();
  });

  it("drops filters that disappear when the same route receives a new URL", () => {
    const view = renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, inStock: true },
    });
    expect(names()).toEqual(["Mango", "Chips"]);

    view.rerender(
      <ShopClient
        products={products}
        categories={categories}
        initialQuery="apple"
        initialShop={DEFAULT_SHOP_QUERY}
      />,
    );

    expect(names()).toEqual(["Apple"]);
    expect(screen.queryByRole("button", { name: /^in stock/i })).toBeNull();
  });

  it("applies the filter panel only on Show, quoting the count first", () => {
    renderShop();
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: /in stock only/i }),
    );
    // The grid behind the panel has not changed yet.
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show 2 products" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Mango", "Chips"]);
    expect(lastUrl()).toBe("/shop?stock=in");
  });

  it("discards the draft when the panel is dismissed", () => {
    renderShop();
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.change(within(dialog).getByLabelText("Minimum price in rupees"), {
      target: { value: "250" },
    });
    expect(
      within(dialog).getByRole("button", { name: "Show 1 product" }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("removes one filter from its chip and says when none match", () => {
    renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, min: 900 },
    });
    expect(names()).toEqual([]);
    expect(screen.getByText("No products match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /from ₹900/i }));
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
  });

  it("names a price range chip in words, never with a long dash", () => {
    renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, min: 100, max: 500 },
    });
    const chip = screen.getByRole("button", {
      name: /^₹100 to ₹500\s*-\s*remove filter$/,
    });
    expect(chip.textContent).not.toMatch(/[\u2013\u2014]/);
  });

  it("shows 24 at a time and reveals the next page on Load more", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      product(`p${i}`, `Product ${i}`, 100 + i),
    );
    render(<ShopClient products={many} categories={categories} />);
    expect(names()).toHaveLength(24);
    expect(screen.getByText("Showing 24 of 30 products")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(names()).toHaveLength(30);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(lastUrl()).toBe("/shop?page=2");
  });

  it("restores every revealed page from the URL", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      product(`p${i}`, `Product ${i}`, 100 + i),
    );
    render(
      <ShopClient
        products={many}
        categories={categories}
        initialShop={{ ...DEFAULT_SHOP_QUERY, pages: 2 }}
      />,
    );
    expect(names()).toHaveLength(30);
  });
});

describe("ShopClient on a collection page", () => {
  it("filters within the collection, keeps a shareable URL and clears the choices", () => {
    window.history.replaceState({}, "", "/collections/juices");
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.change(within(dialog).getByLabelText("Minimum price in rupees"), {
      target: { value: "250" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show 1 product" }),
    );
    expect(names()).toEqual(["Mango"]);
    expect(lastUrl()).toBe("/collections/juices?stock=in&min=250");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(names()).toEqual(["Mango", "Apple"]);
    expect(lastUrl()).toBe("/collections/juices");
  });

  it("shows only that category, titled by it, with no banner by default", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
      />,
    );
    expect(names()).toEqual(["Mango", "Apple"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Juices",
    );
    expect(screen.queryByText("Cold-pressed every morning.")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Juices" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("opens with the category's image and description when the theme asks", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
        collectionBanner
      />,
    );
    expect(screen.getByText("Cold-pressed every morning.")).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/juices.webp",
    );
  });

  it("clears a search back to the collection, not the whole shop", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
        initialQuery="mango"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(replace).toHaveBeenCalledWith("/collections/juices");
  });
});

describe("ShopClient option and category filters", () => {
  const sized = (
    id: string,
    name: string,
    sizes: [string, boolean][],
    category = "c1",
  ) =>
    product(id, name, 500, {
      category_id: category,
      options: [{ name: "Size", values: sizes.map(([s]) => s) }],
      variants: sizes.map(([s, inStock]) => ({
        base_price: 500,
        selling_price: 500,
        special_price: null,
        track_inventory: true,
        stock: inStock ? 3 : 0,
        low_stock_threshold: null,
        allow_backorder: false,
        option_values: [s],
      })),
    });
  const range = [
    sized("tee", "Tee", [
      ["S", true],
      ["M", false],
    ]),
    sized("shirt", "Shirt", [["M", true]], "c2"),
  ];

  it("filters by a size from the sidebar and writes a Shopify-style URL", () => {
    render(
      <ShopClient
        products={range}
        categories={categories}
        initialShop={DEFAULT_SHOP_QUERY}
      />,
    );
    const sidebar = screen.getByRole("complementary", { name: "Filters" });
    fireEvent.click(within(sidebar).getByRole("button", { name: /^M/ }));
    expect(names()).toEqual(["Tee", "Shirt"]);
    expect(lastUrl()).toBe("/shop?filter.v.option.size=m");
    // Only the shirt's M is in stock — the tee has an M, but not to sell.
    fireEvent.click(
      within(sidebar).getByRole("checkbox", { name: /in stock only/i }),
    );
    expect(names()).toEqual(["Shirt"]);
    // A chip per value, which removes just that value.
    fireEvent.click(
      screen.getByRole("button", { name: /^M\s*-\s*remove filter$/ }),
    );
    expect(names()).toEqual(["Tee", "Shirt"]);
  });

  it("filters by category on /shop and counts each choice", () => {
    render(
      <ShopClient
        products={range}
        categories={categories}
        initialShop={DEFAULT_SHOP_QUERY}
      />,
    );
    const sidebar = screen.getByRole("complementary", { name: "Filters" });
    const snacks = within(sidebar).getByRole("checkbox", { name: /snacks/i });
    expect(snacks.closest("label")!.textContent).toContain("(1)");
    fireEvent.click(snacks);
    expect(names()).toEqual(["Shirt"]);
    expect(lastUrl()).toBe("/shop?filter.p.category=snacks");
  });

  it("has no category filter on a collection page", () => {
    render(
      <ShopClient
        products={range}
        categories={categories}
        collection={categories[0]}
        initialShop={DEFAULT_SHOP_QUERY}
      />,
    );
    const sidebar = screen.getByRole("complementary", { name: "Filters" });
    expect(within(sidebar).queryByText("Category")).toBeNull();
  });
});

describe("ShopClient one card per colour", () => {
  const variant = (id: string, colour: string, stock = 3) => ({
    id,
    base_price: 999,
    selling_price: 999,
    special_price: null,
    track_inventory: true,
    stock,
    low_stock_threshold: null,
    allow_backorder: false,
    option_values: [colour],
  });
  const sweatshirt = product("sw", "Loose Fit Sweatshirt", 999, {
    image_url: "/blue.jpg",
    options: [
      {
        name: "Colour",
        values: ["Light blue", "Brown"],
        images: { "Light blue": ["/blue.jpg"], Brown: ["/brown.jpg"] },
      },
    ],
    variants: [variant("v1", "Light blue"), variant("v2", "Brown")],
  });

  it("shows each colour as its own card when the store asks", () => {
    render(
      <ShopClient
        products={[sweatshirt]}
        categories={categories}
        initialShop={DEFAULT_SHOP_QUERY}
        productCards="colour"
      />,
    );
    expect(names()).toEqual(["Loose Fit Sweatshirt", "Loose Fit Sweatshirt"]);
  });

  it("filters colour cards by colour", () => {
    render(
      <ShopClient
        products={[sweatshirt]}
        categories={categories}
        initialShop={{ ...DEFAULT_SHOP_QUERY, options: { color: ["brown"] } }}
        productCards="colour"
      />,
    );
    expect(names()).toEqual(["Loose Fit Sweatshirt"]);
  });

  it("keeps one card per product by default", () => {
    render(
      <ShopClient
        products={[sweatshirt]}
        categories={categories}
        initialShop={DEFAULT_SHOP_QUERY}
      />,
    );
    expect(names()).toEqual(["Loose Fit Sweatshirt"]);
  });
});

// Plan Phase 2e: the collection template decides where the filters live, how
// the grid pages, and which promotional tiles sit among the cards.
describe("ShopClient collection template", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    product(`p${i}`, `Product ${i}`, 100 + i),
  );
  const tpl = (
    over: Partial<
      Parameters<typeof ShopClient>[0]["collectionTemplate"] & object
    >,
  ) => ({
    filters: "sidebar" as const,
    pagination: "load-more" as const,
    promoTiles: [],
    ...over,
  });

  it("keeps the sidebar by default, drops it for the drawer and floats a filter bar for top-bar", () => {
    const { container, rerender } = render(
      <ShopClient products={products} categories={categories} />,
    );
    expect(container.querySelector(".shop-sidebar")).toBeTruthy();
    expect(
      container.querySelector(".shop-filter-btn.has-sidebar"),
    ).toBeTruthy();
    rerender(
      <ShopClient
        products={products}
        categories={categories}
        collectionTemplate={tpl({ filters: "drawer" })}
      />,
    );
    expect(container.querySelector(".shop-sidebar")).toBeNull();
    expect(container.querySelector(".shop-topbar-filters")).toBeNull();
    expect(container.querySelector(".shop-filter-btn.has-sidebar")).toBeNull();
    rerender(
      <ShopClient
        products={products}
        categories={categories}
        collectionTemplate={tpl({ filters: "top-bar" })}
      />,
    );
    expect(container.querySelector(".shop-sidebar")).toBeNull();
    const bar = container.querySelector(".shop-topbar-filters")!;
    expect(bar).toBeTruthy();
    // Every group starts closed, a popover rather than an open list.
    const groups = bar.querySelectorAll("details.shop-filter-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((g) => expect((g as HTMLDetailsElement).open).toBe(false));
    expect(container.querySelector(".shop-filter-btn.has-topbar")).toBeTruthy();
    // Ticking a value in the bar applies at once.
    fireEvent.click(within(bar as HTMLElement).getByLabelText(/In stock only/));
    expect(lastUrl()).toBe("/shop?stock=in");
  });

  it("pages by number: one page at a time, Previous and Next, the URL page", () => {
    render(
      <ShopClient
        products={many}
        categories={categories}
        collectionTemplate={tpl({ pagination: "paged" })}
      />,
    );
    expect(names()).toHaveLength(24);
    expect(screen.getByText("Showing 1 to 24 of 30 products")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(
      within(nav).getByRole("button", { name: "Previous" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(within(nav).getByRole("button", { name: "Page 2" }));
    expect(names()).toHaveLength(6);
    expect(names()[0]).toBe("Product 24");
    expect(lastUrl()).toBe("/shop?page=2");
    expect(
      within(nav)
        .getByRole("button", { name: "Page 2" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(within(nav).getByRole("button", { name: "Next" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(nav).getByRole("button", { name: "Previous" }));
    expect(names()).toHaveLength(24);
  });

  it("shows the last page when a shared link names a page past the end", () => {
    render(
      <ShopClient
        products={many}
        categories={categories}
        initialShop={{ ...DEFAULT_SHOP_QUERY, pages: 9 }}
        collectionTemplate={tpl({ pagination: "paged" })}
      />,
    );
    expect(names()).toHaveLength(6);
  });

  it("reveals the next page as the sentinel comes into view, keeping Load more", () => {
    const observers: {
      cb: IntersectionObserverCallback;
      observe: ReturnType<typeof vi.fn>;
    }[] = [];
    class FakeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb, observe: this.observe });
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      render(
        <ShopClient
          products={many}
          categories={categories}
          collectionTemplate={tpl({ pagination: "infinite" })}
        />,
      );
      expect(names()).toHaveLength(24);
      expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
      expect(observers).toHaveLength(1);
      act(() => {
        observers[0].cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(names()).toHaveLength(30);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(lastUrl()).toBe("/shop?page=2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("places a promotional tile after the Nth card, on the page that holds it", () => {
    const tile = {
      afterIndex: 2,
      heading: "Summer edit",
      body: "Linen, loosened.",
      cta_label: "See the edit",
      href: "/collections/summer",
      image_url: "",
      image_alt: "",
      theme: "dark" as const,
      background: "#123456",
    };
    const far = { ...tile, afterIndex: 26, heading: "Last call", href: "" };
    const { container, rerender } = render(
      <ShopClient
        products={many}
        categories={categories}
        collectionTemplate={tpl({
          pagination: "paged",
          promoTiles: [tile, far],
        })}
      />,
    );
    const grid = container.querySelector(".shop-grid")!;
    const kinds = () =>
      Array.from(grid.children).map((el) =>
        el.classList.contains("shop-promo-tile") ? "tile" : "card",
      );
    expect(kinds().slice(0, 4)).toEqual(["card", "card", "tile", "card"]);
    const link = grid.querySelector("a.shop-promo-tile")!;
    expect(link.getAttribute("href")).toBe("/collections/summer");
    expect((link as HTMLElement).style.background).toContain("rgb(18, 52, 86)");
    expect(screen.getByText("See the edit")).toBeTruthy();
    expect(screen.queryByText("Last call")).toBeNull();
    // Page 2 holds cards 25–30, so the tile after card 26 appears there, and
    // a tile with no link is a plain box.
    rerender(
      <ShopClient
        products={many}
        categories={categories}
        initialShop={{ ...DEFAULT_SHOP_QUERY, pages: 2 }}
        collectionTemplate={tpl({
          pagination: "paged",
          promoTiles: [tile, far],
        })}
      />,
    );
    expect(kinds()).toEqual([
      "card",
      "card",
      "tile",
      "card",
      "card",
      "card",
      "card",
    ]);
    expect(grid.querySelector("div.shop-promo-tile")?.textContent).toContain(
      "Last call",
    );
    expect(screen.queryByText("Summer edit")).toBeNull();
  });
});
