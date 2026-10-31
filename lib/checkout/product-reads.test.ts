import { describe, expect, it } from "vitest";
import { cartLinePhotos, shopperLinePhoto } from "./product-reads";

// The two pure helpers behind getCartStock's line photo. The reads in this
// module are checked against real rows in
// lib/moderation/shopper-reads.local.test.ts and as SQL in
// app/actions/checkout-actions.test.ts.

const LEAD = "https://cdn.example.com/lead.jpg";
const SECOND = "https://cdn.example.com/second.jpg";
const RED_1 = "https://cdn.example.com/red-1.jpg";
const RED_2 = "https://cdn.example.com/red-2.jpg";
const BLUE_1 = "https://cdn.example.com/blue-1.jpg";
const OWN = "https://cdn.example.com/variant-own.jpg";

const colourOptions = [
  {
    name: "Colour",
    values: ["Red", "Blue"],
    images: { Red: [RED_1, RED_2], Blue: [BLUE_1] },
  },
  { name: "Size", values: ["S", "M"] },
];

describe("cartLinePhotos: the photos the product page offers for a line", () => {
  it("a simple product offers its gallery, lead first, no blanks or repeats", () => {
    expect(
      cartLinePhotos(
        { image_url: LEAD, images: ["", LEAD, SECOND], options: [] },
        null,
      ),
    ).toEqual([LEAD, SECOND]);
  });

  it("a variant with photos of its own offers only those", () => {
    expect(
      cartLinePhotos(
        { image_url: LEAD, images: [SECOND], options: colourOptions },
        { images: [OWN, "", OWN], option_values: ["Red", "S"] },
      ),
    ).toEqual([OWN]);
  });

  it("a variant with none offers its colour's photos", () => {
    expect(
      cartLinePhotos(
        { image_url: LEAD, images: [SECOND], options: colourOptions },
        { images: [""], option_values: ["Red", "M"] },
      ),
    ).toEqual([RED_1, RED_2]);
  });

  it("a variant with no photos and no colour photos offers the gallery", () => {
    expect(
      cartLinePhotos(
        { image_url: LEAD, images: [SECOND], options: [] },
        { images: null, option_values: null },
      ),
    ).toEqual([LEAD, SECOND]);
  });

  it("a product with no photo offers nothing", () => {
    expect(
      cartLinePhotos({ image_url: null, images: [""], options: [] }, null),
    ).toEqual([]);
  });
});

describe("shopperLinePhoto: the shopper's own photo, compared, never trusted", () => {
  it("is kept while it is one of the line's photos", () => {
    expect(shopperLinePhoto([LEAD, SECOND], SECOND)).toBe(SECOND);
  });

  it("is dropped when the product no longer has it", () => {
    expect(
      shopperLinePhoto([LEAD], "https://cdn.example.com/gone.jpg"),
    ).toBeNull();
  });

  it("matches the whole address exactly, not a prefix or another spelling", () => {
    expect(shopperLinePhoto([LEAD], `${LEAD}?w=100`)).toBeNull();
    expect(shopperLinePhoto([LEAD], LEAD.toUpperCase())).toBeNull();
    expect(shopperLinePhoto([LEAD], ` ${LEAD}`)).toBeNull();
  });

  it("ignores anything that is not a non-empty string", () => {
    for (const value of [undefined, null, "", 42, { url: LEAD }, [LEAD]]) {
      expect(shopperLinePhoto([LEAD, ""], value)).toBeNull();
    }
  });
});
