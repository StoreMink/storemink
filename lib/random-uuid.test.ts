import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("falls back when randomUUID throws instead of being missing", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("not a secure context");
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => (bytes[index] = index * 7));
        return bytes;
      },
    });
    const id = randomUuid();
    expect(id).toMatch(V4);
    expect(id.startsWith("00070e15")).toBe(true);
  });

  it("still returns distinct v4 UUIDs with no crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = Array.from({ length: 50 }, () => randomUuid());
    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(50);
  });
});
