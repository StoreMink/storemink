import { describe, expect, it } from "vitest";
import {
  imageInUseMessage,
  usedByLabel,
  type StorefrontImageUsage,
} from "./library-types";

/** An en or em dash, built from code points so no dash is typed here. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const none: StorefrontImageUsage = {
  redesignInProgress: false,
  redesignCard: false,
  pages: [],
  categories: [],
  headerFooter: false,
};

describe("usedByLabel", () => {
  it("names one, two, or one and a count", () => {
    expect(usedByLabel([{ id: "1", name: "Shake" }])).toBe("Shake");
    expect(
      usedByLabel([
        { id: "2", name: "Tea" },
        { id: "1", name: "Coffee" },
      ]),
    ).toBe("Coffee and Tea");
    expect(
      usedByLabel([
        { id: "1", name: "A" },
        { id: "2", name: "B" },
        { id: "3", name: "C" },
      ]),
    ).toBe("A and 2 more");
  });
});

// The Media Library's delete guard: why an image cannot be deleted yet.
describe("imageInUseMessage", () => {
  it("says nothing when nothing in the store shows the image", () => {
    expect(imageInUseMessage(none)).toBeNull();
  });

  it("names the pages that show it", () => {
    expect(imageInUseMessage({ ...none, pages: ["Home"] })).toBe(
      "The Home page uses this image. Change the photo on that page in the Website Builder first.",
    );
    expect(imageInUseMessage({ ...none, pages: ["Home", "About"] })).toBe(
      "The Home and About pages use this image. Change the photo on those pages in the Website Builder first.",
    );
    expect(
      imageInUseMessage({ ...none, pages: ["Home", "About", "Contact"] }),
    ).toBe(
      "The Home page and 2 more pages use this image. Change the photo on those pages in the Website Builder first.",
    );
  });

  it("names the categories whose photo it is", () => {
    expect(imageInUseMessage({ ...none, categories: ["Juices"] })).toBe(
      "The Juices category uses this image. Change that category's photo first.",
    );
    expect(
      imageInUseMessage({ ...none, categories: ["Juices", "Shakes"] }),
    ).toBe(
      "The Juices and Shakes categories use this image. Change their photos first.",
    );
  });

  it("names the header or footer", () => {
    expect(imageInUseMessage({ ...none, headerFooter: true })).toMatch(
      /^Your header or footer uses this image\./,
    );
  });

  it("names a redesign card nobody has applied", () => {
    expect(imageInUseMessage({ ...none, redesignCard: true })).toMatch(
      /storefront redesign from Mink AI uses this image and has not been applied yet/,
    );
  });

  // ★ The answer to act on first: a redesign still being made outranks its
  //   card, and both outrank a page (the card is what would write the page).
  it("puts a redesign still being made first, then a card, then pages", () => {
    const all: StorefrontImageUsage = {
      redesignInProgress: true,
      redesignCard: true,
      pages: ["Home"],
      categories: ["Juices"],
      headerFooter: true,
    };
    expect(imageInUseMessage(all)).toMatch(/^Mink AI is still making/);
    expect(imageInUseMessage({ ...all, redesignInProgress: false })).toMatch(
      /has not been applied yet/,
    );
    expect(
      imageInUseMessage({
        ...all,
        redesignInProgress: false,
        redesignCard: false,
      }),
    ).toMatch(/^The Home page uses/);
    expect(
      imageInUseMessage({
        ...none,
        categories: ["Juices"],
        headerFooter: true,
      }),
    ).toMatch(/^The Juices category uses/);
  });

  it("never writes a long dash", () => {
    const all: StorefrontImageUsage[] = [
      { ...none, redesignInProgress: true },
      { ...none, redesignCard: true },
      { ...none, pages: ["A", "B", "C"] },
      { ...none, categories: ["A", "B", "C"] },
      { ...none, headerFooter: true },
    ];
    for (const usage of all) {
      expect(imageInUseMessage(usage)).not.toMatch(LONG_DASH);
    }
  });
});
