import { describe, expect, it } from "vitest";
import {
  IMAGE_SPECS,
  croppedFraction,
  imageFitWarning,
  isImageSpecKey,
  specForRatio,
} from "./image-specs";

const RATIOS: Record<string, number> = {
  "1:1": 1,
  "3:4": 3 / 4,
  "4:3": 4 / 3,
  "4:5": 4 / 5,
  "16:9": 16 / 9,
  "21:9": 21 / 9,
};

describe("IMAGE_SPECS", () => {
  // The refine route asks the model for `aspect` and then fits to
  // width × height; if the two disagreed the model's output would be cropped.
  it.each(Object.entries(IMAGE_SPECS).filter(([, s]) => s.refine))(
    "%s: width × height matches its aspect",
    (_key, spec) => {
      expect(spec.width / spec.height).toBeCloseTo(RATIOS[spec.aspect], 2);
    },
  );

  it("never offers refine for a logo", () => {
    expect(IMAGE_SPECS.logo.refine).toBe(false);
  });

  it("matches the classic product card's 3:4 frame", () => {
    expect(IMAGE_SPECS.product).toMatchObject({
      width: 1200,
      height: 1600,
      aspect: "3:4",
    });
  });

  it("recognises only catalogue keys", () => {
    expect(isImageSpecKey("product")).toBe(true);
    expect(isImageSpecKey("toString")).toBe(false);
    expect(isImageSpecKey(42)).toBe(false);
  });

  it("maps section ratio settings", () => {
    expect(specForRatio("square")).toBe("square");
    expect(specForRatio("landscape")).toBe("landscape");
    expect(specForRatio(undefined)).toBe("portrait");
  });
});

describe("imageFitWarning", () => {
  const product = IMAGE_SPECS.product;

  it("is silent for an exact fit", () => {
    expect(croppedFraction(1200, 1600, product)).toBe(0);
    expect(imageFitWarning(1200, 1600, product)).toBeNull();
  });

  it("explains a square photo in a 3:4 frame loses its sides", () => {
    expect(imageFitWarning(1080, 1080, product)).toMatch(
      /crop about 25% from the sides/,
    );
  });

  it("explains a landscape banner photo loses top and bottom", () => {
    expect(imageFitWarning(1000, 1000, IMAGE_SPECS.hero_wide)).toMatch(
      /top and bottom/,
    );
  });

  it("flags a well-shaped but small photo", () => {
    expect(imageFitWarning(600, 800, product)).toMatch(/smaller than/);
  });

  it("ignores unknown dimensions", () => {
    expect(imageFitWarning(0, 0, product)).toBeNull();
  });
});

describe("productPhotoSpec", () => {
  it("follows the store's card photo shape", async () => {
    const { productPhotoSpec } = await import("./image-specs");
    expect(productPhotoSpec("square")).toBe("product_square");
    expect(productPhotoSpec("portrait")).toBe("product");
    expect(productPhotoSpec(undefined)).toBe("product");
    expect(IMAGE_SPECS.product_square).toMatchObject({
      width: 1200,
      height: 1200,
      aspect: "1:1",
    });
  });
});
