import { describe, expect, it } from "vitest";
import {
  EMPTY_COVERAGE,
  FULL_COVERAGE,
  MAX_OUTPUT_EDGE,
  MEAN,
  STD,
  judgeMask,
  looksLikeLogits,
  maskFromOutput,
  maskStats,
  outputSize,
  parseOutput,
  secretMatches,
  sniffImageType,
  toInputTensor,
} from "./matting-core.mjs";

const pad = (bytes) => Uint8Array.from([...bytes, ...new Array(16).fill(0)]);

describe("sniffImageType", () => {
  it("recognises JPEG, PNG and WebP by their first bytes", () => {
    expect(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(
      sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(
      sniffImageType(
        pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("webp");
  });

  it("refuses everything else, including a RIFF file that is not WebP", () => {
    expect(sniffImageType(pad([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(sniffImageType(pad([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // <svg
    expect(
      sniffImageType(
        pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeNull(); // RIFF....WAVE
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull(); // too short
    expect(sniffImageType(null)).toBeNull();
  });
});

describe("parseOutput", () => {
  it("defaults to the mask and accepts the two outputs", () => {
    expect(parseOutput(null)).toBe("mask");
    expect(parseOutput(undefined)).toBe("mask");
    expect(parseOutput("")).toBe("mask");
    expect(parseOutput("mask")).toBe("mask");
    expect(parseOutput("cutout")).toBe("cutout");
  });

  it("refuses anything else rather than guessing", () => {
    expect(parseOutput("svg")).toBeNull();
    expect(parseOutput("Mask")).toBeNull();
  });
});

describe("toInputTensor", () => {
  it("normalises each channel and lays them out as planes", () => {
    // A 2×2 image: red, green, blue, white.
    const rgb = Uint8Array.from([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255,
    ]);
    const t = toInputTensor(rgb, 2);
    const plane = 4;
    const norm = (value, c) => (value / 255 - MEAN[c]) / STD[c];
    expect(t).toHaveLength(12);
    // Pixel 0 is red: high in the red plane, low in green and blue.
    expect(t[0]).toBeCloseTo(norm(255, 0), 5);
    expect(t[plane + 0]).toBeCloseTo(norm(0, 1), 5);
    expect(t[2 * plane + 0]).toBeCloseTo(norm(0, 2), 5);
    // Pixel 1 is green.
    expect(t[1]).toBeCloseTo(norm(0, 0), 5);
    expect(t[plane + 1]).toBeCloseTo(norm(255, 1), 5);
    // Pixel 3 is white in every plane.
    for (let c = 0; c < 3; c += 1) {
      expect(t[c * plane + 3]).toBeCloseTo(norm(255, c), 5);
    }
  });

  it("refuses a buffer of the wrong size", () => {
    expect(() => toInputTensor(new Uint8Array(11), 2)).toThrow(RangeError);
  });
});

describe("maskFromOutput", () => {
  it("applies a sigmoid to logits", () => {
    const mask = maskFromOutput(Float32Array.from([-20, 0, 20]));
    expect(Array.from(mask)).toEqual([0, 128, 255]);
  });

  it("does not apply a second sigmoid to probabilities", () => {
    // Twice-sigmoided, 0 would become 128 and 1 would become 186.
    const values = Float32Array.from([0, 0.5, 1]);
    expect(looksLikeLogits(values)).toBe(false);
    expect(Array.from(maskFromOutput(values))).toEqual([0, 128, 255]);
  });

  it("reads a broken value as background, never as product", () => {
    expect(
      Array.from(maskFromOutput(Float32Array.from([Number.NaN, 0.75]))),
    ).toEqual([0, 191]);
  });
});

describe("maskStats and judgeMask", () => {
  it("measures clear product and unsure pixels", () => {
    const mask = Uint8Array.from([0, 0, 255, 255, 128, 64, 0, 0, 0, 0]);
    const stats = maskStats(mask);
    expect(stats.coverage).toBeCloseTo(0.3, 5); // 255, 255, 128
    expect(stats.soft).toBeCloseTo(0.2, 5); // 128, 64
  });

  it("calls a near-empty mask empty and a near-solid one full", () => {
    expect(judgeMask({ coverage: EMPTY_COVERAGE / 2 })).toBe("empty");
    expect(judgeMask({ coverage: 0.2 })).toBe("ok");
    expect(judgeMask({ coverage: (FULL_COVERAGE + 1) / 2 })).toBe("full");
    expect(maskStats(new Uint8Array(0))).toEqual({ coverage: 0, soft: 0 });
  });
});

describe("outputSize", () => {
  it("keeps a photo that fits", () => {
    expect(outputSize(3000, 2000)).toEqual({ width: 3000, height: 2000 });
  });

  it("scales a larger one to fit, keeping its shape", () => {
    expect(outputSize(8000, 6000)).toEqual({
      width: MAX_OUTPUT_EDGE,
      height: 3072,
    });
    expect(outputSize(1000, 9000, 900)).toEqual({ width: 100, height: 900 });
  });
});

describe("secretMatches", () => {
  it("accepts only the exact secret", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretMatches("s3cret-valuE", "s3cret-value")).toBe(false);
    expect(secretMatches("s3cret", "s3cret-value")).toBe(false);
  });

  it("refuses a missing value and never matches an empty expected secret", () => {
    expect(secretMatches(undefined, "x")).toBe(false);
    expect(secretMatches("", "x")).toBe(false);
    expect(secretMatches(["x"], "x")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});
