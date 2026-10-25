// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ShopByCategorySection,
  type CategoryTile,
} from "./shop-by-category-section";

// Plan Phase 2c: the collection list display — each category a row with its
// picture, name and description, the whole row one link.
const categories: CategoryTile[] = [
  {
    id: "c1",
    name: "Fruits & Vegetables",
    slug: "fruits-vegetables",
    image_url: "/themes/basket/cat-fruits-veg.webp",
    description: "Farm-fresh produce, restocked every morning.",
  },
  {
    id: "c2",
    name: "Staples",
    slug: "staples",
    image_url: null,
    description: "  ",
  },
];

const config = {
  heading: "Shop by department",
  subheading: "",
  source: "all" as const,
  category_ids: [],
  layout: "grid" as const,
  display: "list" as const,
};

describe("ShopByCategorySection list display", () => {
  it("renders one linked row per category with its description", () => {
    const { container } = render(
      <ShopByCategorySection
        sectionId="cats"
        config={config}
        categories={categories}
      />,
    );
    const list = container.querySelector("ul.home-cat-list")!;
    expect(list.className).toBe("home-cat-list is-two-up");
    const rows = container.querySelectorAll("li.home-cat-row");
    expect(rows).toHaveLength(2);
    const links = container.querySelectorAll("a.home-cat-row-link");
    expect(links[0].getAttribute("href")).toBe(
      "/collections/fruits-vegetables",
    );
    expect(links[0].querySelector(".home-cat-row-name")?.textContent).toBe(
      "Fruits & Vegetables",
    );
    expect(links[0].querySelector(".home-cat-row-desc")?.textContent).toBe(
      "Farm-fresh produce, restocked every morning.",
    );
    // A blank description renders no empty line; a missing picture renders
    // the placeholder.
    expect(links[1].querySelector(".home-cat-row-desc")).toBeNull();
    expect(links[1].querySelector(".home-cat-img-placeholder")).not.toBeNull();
    // Never the tile markup.
    expect(container.querySelector(".home-cat-tile")).toBeNull();
    expect(container.querySelector(".home-section-title")?.textContent).toBe(
      "Shop by department",
    );
  });

  it("is one column under the scroll layout, and the tiles otherwise", () => {
    const { container } = render(
      <ShopByCategorySection
        sectionId="cats"
        config={{ ...config, layout: "scroll" }}
        categories={categories}
      />,
    );
    expect(container.querySelector("ul.home-cat-list")?.className).toBe(
      "home-cat-list",
    );
    const tiles = render(
      <ShopByCategorySection
        sectionId="cats"
        config={{ ...config, display: "cards" }}
        categories={categories}
      />,
    );
    expect(tiles.container.querySelector(".home-cat-list")).toBeNull();
    expect(tiles.container.querySelectorAll(".home-cat-tile")).toHaveLength(2);
    expect(tiles.container.querySelector(".home-cat-grid")?.className).toBe(
      "home-cat-grid is-cards",
    );
  });
});

// L2-K (live run, 2026-10-22): three categories sat at the left of an empty
// row. homepage.css centres a grid row that fits by capping the grid at what
// its own tiles need, so the grid has to say how many it holds; the scroll
// row centres itself with auto margins and needs nothing.
describe("ShopByCategorySection short rows", () => {
  const tiles = (n: number): CategoryTile[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      name: `Category ${i}`,
      slug: `category-${i}`,
      image_url: null,
    }));

  it("the grid carries its tile count, which caps a short row", () => {
    for (const count of [1, 3, 12]) {
      const { container, unmount } = render(
        <ShopByCategorySection
          sectionId="cats"
          config={{ ...config, display: "circles" }}
          categories={tiles(count)}
        />,
      );
      const grid = container.querySelector<HTMLElement>(".home-cat-grid")!;
      expect(grid.style.getPropertyValue("--sm-cat-count")).toBe(String(count));
      expect(grid.querySelectorAll(".home-cat-tile")).toHaveLength(count);
      unmount();
    }
  });

  it("the scroll row's tiles are the scroller's own children, which its auto margins need", () => {
    // jsdom has no ResizeObserver; the carousel only uses it to grey arrows.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { container } = render(
      <ShopByCategorySection
        sectionId="cats"
        config={{ ...config, layout: "scroll", display: "circles" }}
        categories={tiles(3)}
      />,
    );
    const scroller = container.querySelector(".home-cat-scroll")!;
    expect(
      [...scroller.children].every((child) =>
        child.classList.contains("home-cat-tile"),
      ),
    ).toBe(true);
    expect(scroller.children).toHaveLength(3);
    expect(container.querySelector(".home-cat-grid")).toBeNull();
    vi.unstubAllGlobals();
  });
});
