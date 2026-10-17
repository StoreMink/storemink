import { describe, expect, it } from "vitest";
import {
  MAX_UPSCALE,
  PRODUCT_FILL,
  backgroundFill,
  backgroundKey,
  cutoutChecks,
  isCutoutCheck,
  maskBounds,
  parseBackground,
  placeInFrame,
} from "./background-layout";

describe("parseBackground", () => {
  it("accepts the three backgrounds", () => {
    expect(parseBackground({ kind: "white" })).toEqual({ kind: "white" });
    expect(parseBackground({ kind: "transparent" })).toEqual({
      kind: "transparent",
    });
    expect(parseBackground({ kind: "colour", hex: "#F5EFE6" })).toEqual({
      kind: "colour",
      hex: "#f5efe6",
    });
  });

  it("refuses anything that is not exactly #rrggbb", () => {
    for (const hex of [
      "#fff",
      "f5efe6",
      "#f5efe6;",
      "red",
      "#gggggg",
      "../x",
    ]) {
      expect(parseBackground({ kind: "colour", hex })).toBeNull();
    }
    expect(parseBackground({ kind: "black" })).toBeNull();
    expect(parseBackground(null)).toBeNull();
    expect(parseBackground("white")).toBeNull();
  });
});

describe("backgroundKey and backgroundFill", () => {
  it("names each background stably", () => {
    expect(backgroundKey({ kind: "white" })).toBe("white");
    expect(backgroundKey({ kind: "transparent" })).toBe("transparent");
    expect(backgroundKey({ kind: "colour", hex: "#F5EFE6" })).toBe("cf5efe6");
  });

  it("fills transparency with nothing and colours opaque", () => {
    expect(backgroundFill({ kind: "transparent" }).alpha).toBe(0);
    expect(backgroundFill({ kind: "white" })).toEqual({
      r: 255,
      g: 255,
      b: 255,
      alpha: 1,
    });
    expect(backgroundFill({ kind: "colour", hex: "#102030" })).toEqual({
      r: 16,
      g: 32,
      b: 48,
      alpha: 1,
    });
  });
});

describe("maskBounds", () => {
  it("finds the box around the product pixels", () => {
    // 5 × 4 mask with product at x 1-3, y 1-2.
    const mask = Uint8Array.from([
      0, 0, 0, 0, 0, 0, 255, 200, 130, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(maskBounds(mask, 5, 4)).toEqual({
      left: 1,
      top: 1,
      width: 3,
      height: 2,
    });
  });

  it("ignores faint pixels and returns null for an empty mask", () => {
    expect(maskBounds(Uint8Array.from([0, 100, 127, 0]), 2, 2)).toBeNull();
    expect(maskBounds(new Uint8Array(3), 2, 2)).toBeNull();
  });
});

describe("placeInFrame", () => {
  it("fills the limiting side and centres, keeping the shape", () => {
    // A tall product in a 3:4 frame: height is the limit.
    const box = placeInFrame(
      { width: 300, height: 900 },
      { width: 1200, height: 1600 },
    );
    expect(box.height).toBe(Math.round(1600 * PRODUCT_FILL));
    expect(box.width).toBe(Math.round(300 * (box.height / 900)));
    expect(box.left).toBe(Math.round((1200 - box.width) / 2));
    expect(box.top).toBe(Math.round((1600 - box.height) / 2));
  });

  it("uses the width when the product is wide", () => {
    const box = placeInFrame(
      { width: 1000, height: 200 },
      { width: 1200, height: 1600 },
    );
    expect(box.width).toBe(Math.round(1200 * PRODUCT_FILL));
    expect(box.top).toBeGreaterThan(box.left);
  });
});

describe("cutoutChecks", () => {
  const frame = { width: 1200, height: 1600 };
  const photo = { width: 2000, height: 2000 };

  it("passes a well-framed product", () => {
    expect(
      cutoutChecks(
        { left: 400, top: 300, width: 900, height: 1200 },
        photo,
        frame,
      ),
    ).toEqual([]);
  });

  it("flags a product that runs off the photo", () => {
    expect(
      cutoutChecks(
        { left: 0, top: 300, width: 900, height: 1200 },
        photo,
        frame,
      ),
    ).toContain("touches_edge");
    expect(
      cutoutChecks(
        { left: 400, top: 300, width: 900, height: 1700 },
        photo,
        frame,
      ),
    ).toContain("touches_edge");
  });

  it("flags a product that would be enlarged too far", () => {
    // 1600 × 0.84 / 600 is 2.24, past MAX_UPSCALE.
    const small = { left: 700, top: 700, width: 450, height: 600 };
    expect(placeInFrame(small, frame).scale).toBeGreaterThan(MAX_UPSCALE);
    expect(cutoutChecks(small, photo, frame)).toEqual(["small"]);
  });

  it("recognises only its own codes", () => {
    expect(isCutoutCheck("small")).toBe(true);
    expect(isCutoutCheck("touches_edge")).toBe(true);
    expect(isCutoutCheck("drop table")).toBe(false);
  });
});
