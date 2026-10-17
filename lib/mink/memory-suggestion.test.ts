import { describe, expect, it } from "vitest";
import {
  minkRandomUuid,
  readMinkMemorySuggestion,
  suggestMinkMemory,
} from "./memory-suggestion";

describe("suggestMinkMemory", () => {
  it("offers a lasting instruction about tone as a brand-voice memory", () => {
    expect(
      suggestMinkMemory(
        "From now on, always write product descriptions in a playful tone.",
      ),
    ).toEqual({
      kind: "brand_voice",
      content:
        "From now on, always write product descriptions in a playful tone.",
      title: "From now on, always write product descriptions in…",
    });
  });

  it("keeps the business fact and drops the question beside it", () => {
    expect(
      suggestMinkMemory(
        "Remember that we only ship within Karnataka. What were sales today?",
      ),
    ).toEqual({
      kind: "business_context",
      content: "We only ship within Karnataka.",
      title: "We only ship within Karnataka",
    });
  });

  it("treats a standing request as a preference", () => {
    expect(suggestMinkMemory("Please always keep answers short.")).toEqual({
      kind: "preference",
      content: "Always keep answers short.",
      title: "Always keep answers short",
    });
  });

  it("never offers a question, a skill, a link or a one-off request", () => {
    expect(suggestMinkMemory("What were sales yesterday?")).toBeNull();
    expect(suggestMinkMemory("Why do I never get orders")).toBeNull();
    expect(suggestMinkMemory("/sales-today")).toBeNull();
    expect(
      suggestMinkMemory("Always use https://example.com/banner.png here"),
    ).toBeNull();
    expect(suggestMinkMemory("Create a coupon for 10% off")).toBeNull();
    expect(suggestMinkMemory("")).toBeNull();
  });

  it("bounds the text the way the memories API does", () => {
    const long = `We sell ${"handmade candles and ".repeat(60)}gifts.`;
    const suggestion = suggestMinkMemory(long);
    expect(suggestion?.kind).toBe("business_context");
    expect(suggestion!.content.length).toBeLessThanOrEqual(600);
    expect(suggestion!.title.length).toBeLessThanOrEqual(80);
    expect(readMinkMemorySuggestion(suggestion)).toEqual(suggestion);
  });

  it("reads only a well-formed suggestion off the wire", () => {
    expect(readMinkMemorySuggestion(null)).toBeNull();
    expect(
      readMinkMemorySuggestion({ title: "x", content: "y", kind: "secret" }),
    ).toBeNull();
    expect(
      readMinkMemorySuggestion({ title: "", content: "y", kind: "preference" }),
    ).toBeNull();
    expect(
      readMinkMemorySuggestion({
        title: "Short answers",
        content: "Keep answers short.",
        kind: "preference",
      }),
    ).toEqual({
      title: "Short answers",
      content: "Keep answers short.",
      kind: "preference",
    });
  });

  it("mints an id the memories API accepts even without randomUUID", () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(minkRandomUuid()).toMatch(uuid);
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(minkRandomUuid()).toMatch(uuid);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });
});
