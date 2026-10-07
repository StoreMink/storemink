import { describe, expect, it } from "vitest";
import { colourCards } from "./colour-cards";

const v = (id: string, values: string[], stock = 5, images: string[] = []) => ({
  id,
  option_values: values,
  images,
  track_inventory: true,
  stock,
  allow_backorder: false,
});

const sweatshirt = {
  id: "p1",
  slug: "loose-fit-sweatshirt",
  image_url: "/blue-1.jpg",
  images: ["/blue-2.jpg"],
  options: [
    { name: "Size", values: ["S", "M"] },
    {
      name: "Colour",
      values: ["Light blue", "Brown", "Black"],
      images: {
        "Light blue": ["/blue-1.jpg", "/blue-2.jpg"],
        Brown: ["/brown-1.jpg"],
      },
    },
  ],
  variants: [
    v("a", ["S", "Light blue"]),
    v("b", ["M", "Light blue"]),
    v("c", ["S", "Brown"], 0),
    v("d", ["M", "Brown"]),
    v("e", ["S", "Black"]),
  ],
};

describe("colourCards", () => {
  it("makes one card per colour, each with only its own variants", () => {
    const cards = colourCards(sweatshirt);
    expect(cards.map((c) => c.colour)).toEqual([
      "Light blue",
      "Brown",
      "Black",
    ]);
    expect(cards[1].product.variants.map((x) => x.id)).toEqual(["c", "d"]);
    expect(cards.map((c) => c.key)).toEqual([
      "p1:Light blue",
      "p1:Brown",
      "p1:Black",
    ]);
  });

  it("uses the colour's photos, and the product's for a colour without", () => {
    const [blue, brown, black] = colourCards(sweatshirt);
    expect(brown.product.image_url).toBe("/brown-1.jpg");
    expect(brown.product.images).toEqual([]);
    expect(blue.product.images).toEqual(["/blue-2.jpg"]);
    expect(black.product.image_url).toBe("/blue-1.jpg");
  });

  it("links to the colour's first in-stock variant", () => {
    const brown = colourCards(sweatshirt)[1];
    // S/Brown is sold out, so the card opens on M/Brown.
    expect(brown.href).toBe("/shop/loose-fit-sweatshirt?variant=d");
  });

  it("stays one card when no colour has its own photo", () => {
    const plain = {
      ...sweatshirt,
      options: [
        { name: "Size", values: ["S", "M"] },
        { name: "Colour", values: ["Light blue", "Brown", "Black"] },
      ],
    };
    const cards = colourCards(plain);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: "p1", href: null, colour: null });
  });

  it("splits on older per-variant photos too", () => {
    const legacy = {
      ...sweatshirt,
      options: [{ name: "Colour", values: ["Red", "Green"] }],
      variants: [v("r", ["Red"], 5, ["/red.jpg"]), v("g", ["Green"])],
    };
    expect(colourCards(legacy).map((c) => c.product.image_url)).toEqual([
      "/red.jpg",
      "/blue-1.jpg",
    ]);
  });

  it("leaves a size-only product alone", () => {
    const sizes = {
      ...sweatshirt,
      options: [{ name: "Size", values: ["S", "M"] }],
      variants: [v("s", ["S"]), v("m", ["M"])],
    };
    expect(colourCards(sizes)).toHaveLength(1);
  });
});
