import { describe, expect, it } from "vitest";
import { parseByteRange } from "./byte-range";

describe("parseByteRange", () => {
  it("no header, or a header covering everything, is the whole file", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("", 100)).toBeNull();
    expect(parseByteRange("bytes=0-", 100)).toBeNull();
    expect(parseByteRange("bytes=0-99", 100)).toBeNull();
    expect(parseByteRange("bytes=0-500", 100)).toBeNull();
  });

  it("★ Safari's opening probe (bytes=0-1) is a two-byte range", () => {
    expect(parseByteRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
  });

  it("an open-ended and a capped range", () => {
    expect(parseByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseByteRange("bytes=10-1000", 100)).toEqual({
      start: 10,
      end: 99,
    });
  });

  it("a suffix range is the last N bytes", () => {
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-500", 100)).toBeNull();
  });

  it("a range past the end, or backwards, is unsatisfiable", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=50-10", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1", 0)).toBe("unsatisfiable");
  });

  it("several ranges, another unit, or junk fall back to the whole file", () => {
    expect(parseByteRange("bytes=0-1, 5-9", 100)).toBeNull();
    expect(parseByteRange("items=0-1", 100)).toBeNull();
    expect(parseByteRange("bytes=a-b", 100)).toBeNull();
    expect(parseByteRange("bytes=-", 100)).toBeNull();
  });
});
