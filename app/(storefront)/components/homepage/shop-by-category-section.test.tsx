// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
