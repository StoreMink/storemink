// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MINK_PRODUCT_PREFILL_KEY,
  minkProductPrefillPath,
  readMinkProductPrefill,
  storeMinkProductPrefill,
  takeMinkProductPrefill,
} from "./product-prefill";

describe("Mink product prefill", () => {
  it("keeps only the form's fields, bounded, in either naming", () => {
    expect(
      readMinkProductPrefill({
        name: "  Oat milk  ",
        description: "x".repeat(3_500),
        seo_title: "Oat milk",
        sellingPrice: "199.999",
        base_price: -5,
        stock: 40,
        status: "published",
      }),
    ).toEqual({
      name: "Oat milk",
      description: "x".repeat(3_000),
      seoTitle: "Oat milk",
      sellingPrice: 200,
    });
    expect(readMinkProductPrefill({ stock: 4 })).toBeNull();
    expect(readMinkProductPrefill("nope")).toBeNull();
  });

  it("stores for one navigation and clears itself when taken", () => {
    expect(storeMinkProductPrefill({ name: "Oat milk" })).toBe(true);
    expect(minkProductPrefillPath()).toBe(
      "/dashboard/products/new?prefill=mink",
    );
    expect(takeMinkProductPrefill()).toEqual({ name: "Oat milk" });
    expect(window.sessionStorage.getItem(MINK_PRODUCT_PREFILL_KEY)).toBeNull();
    expect(takeMinkProductPrefill()).toBeNull();
  });
});
