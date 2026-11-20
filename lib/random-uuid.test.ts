import { describe, expect, it } from "vitest";
import { randomUuid } from "./random-uuid";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function withoutRandomUuid<T>(run: () => T): T {
  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: original,
    });
  }
}

describe("randomUuid", () => {
  it("returns a v4 UUID", () => {
    expect(randomUuid()).toMatch(V4);
  });

  it("still returns a v4 UUID where crypto.randomUUID is missing (plain http)", () => {
    withoutRandomUuid(() => {
      expect(randomUuid()).toMatch(V4);
    });
  });

  it("does not repeat itself on the fallback", () => {
    const ids = withoutRandomUuid(() =>
      Array.from({ length: 200 }, () => randomUuid()),
    );
    expect(new Set(ids).size).toBe(200);
  });
});
