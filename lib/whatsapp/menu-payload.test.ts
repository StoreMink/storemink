import { describe, expect, it } from "vitest";
import { menuButtonPayload, parseMenuPayload } from "./menu-payload";

describe("menu button payloads", () => {
  it("round-trips a button id", () => {
    expect(parseMenuPayload(menuButtonPayload("track_2k9x"))).toBe(
      "track_2k9x",
    );
  });

  it("★ refuses anything it did not write", () => {
    expect(parseMenuPayload("cod:confirm:x")).toBeNull();
    expect(parseMenuPayload("menu:")).toBeNull();
    expect(parseMenuPayload("menu:Has Space")).toBeNull();
    expect(parseMenuPayload("menu:UPPER")).toBeNull();
    expect(parseMenuPayload(`menu:${"a".repeat(33)}`)).toBeNull();
    expect(parseMenuPayload(42)).toBeNull();
    expect(parseMenuPayload(null)).toBeNull();
    expect(parseMenuPayload(undefined)).toBeNull();
  });
});
