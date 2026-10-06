// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ShopCard, type ShopCardProduct } from "./shop-card";

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={props.src} alt={props.alt} />
  ),
}));
vi.mock("./quick-add-button", () => ({ QuickAddButton: () => null }));

afterEach(cleanup);

function product(overrides: Partial<ShopCardProduct> = {}): ShopCardProduct {
  return {
    id: "p1",
    name: "Circuit State Long Sleeve T-Shirt",
    slug: "circuit-state",
    image_url: "https://example.com/a.jpg",
    base_price: 1299,
    selling_price: 1199,
    special_price: null,
    track_inventory: true,
    stock: 50,
    low_stock_threshold: null,
    allow_backorder: false,
    variants: [],
    ...overrides,
  } as ShopCardProduct;
}

const flag = (c: HTMLElement) => c.querySelector(".shop-card-flag");

describe("ShopCard", () => {
  it("puts the markdown on the photo and the MRP before the sale price", () => {
    const { container } = render(<ShopCard product={product()} />);
    expect(flag(container)?.textContent).toBe("Save 8%");
    expect(flag(container)?.closest(".shop-card-img")).not.toBeNull();
    const price = container.querySelector(".shop-card-price")!;
    const base = price.querySelector(".shop-card-base")!;
    const sell = price.querySelector(".shop-card-sell--sale")!;
    expect(
      base.compareDocumentPosition(sell) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no flag and no struck price without a markdown", () => {
    const { container } = render(
      <ShopCard product={product({ base_price: 1199 })} />,
    );
    expect(flag(container)).toBeNull();
    expect(container.querySelector(".shop-card-base")).toBeNull();
  });

  it("ranks sold out over low stock over an offer over the markdown", () => {
    const offer = { label: "20% off" };
    expect(
      flag(
        render(<ShopCard product={product({ stock: 0 })} offerBadge={offer} />)
          .container,
      )?.textContent,
    ).toBe("Sold out");
    cleanup();
    expect(
      flag(
        render(
          <ShopCard
            product={product({ stock: 2, low_stock_threshold: 5 })}
            offerBadge={offer}
          />,
        ).container,
      )?.textContent,
    ).toBe("Only 2 left");
    cleanup();
    expect(
      flag(
        render(<ShopCard product={product()} offerBadge={offer} />).container,
      )?.textContent,
    ).toBe("20% off");
  });
});

describe("ShopCard colour row", () => {
  const options = [
    { name: "Size", values: ["S", "M"] },
    {
      name: "Colour",
      values: ["Black", "Tan", "Navy", "Olive", "Rust", "Sand"],
      swatches: { Black: "#111111" },
    },
  ];

  it("shows four colours and the rest as +N", () => {
    const { container } = render(<ShopCard product={product({ options })} />);
    expect(container.querySelectorAll(".shop-card-colour")).toHaveLength(4);
    expect(container.querySelector(".shop-card-colour-more")?.textContent).toBe(
      "+2",
    );
    expect(container.textContent).toContain("Available in 6 colours");
  });

  it("has no colour row for a product with one colour or none", () => {
    const { container } = render(
      <ShopCard
        product={product({ options: [{ name: "Colour", values: ["Black"] }] })}
      />,
    );
    expect(container.querySelector(".shop-card-colours")).toBeNull();
  });

  it("a per-colour card links to its colour and says which it is", () => {
    const { container } = render(
      <ShopCard
        product={product({ options })}
        href="/shop/circuit-state?variant=v9"
        colour="Black"
      />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/shop/circuit-state?variant=v9",
    );
    expect(container.querySelector("img")?.getAttribute("alt")).toContain(
      "Black",
    );
    expect(
      container.querySelector(".shop-card-colour.is-current"),
    ).not.toBeNull();
  });
});
