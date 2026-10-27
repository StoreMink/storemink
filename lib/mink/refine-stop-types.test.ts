import { describe, expect, it } from "vitest";
import {
  REFINE_STOP_TOKEN_PATTERN,
  readRefineStopAnswer,
} from "./refine-stop-types";

describe("★★ readRefineStopAnswer: strict, so only an explicit stop says nothing was charged", () => {
  it("reads the three decided answers", () => {
    expect(readRefineStopAnswer({ outcome: "stopped" })).toEqual({
      outcome: "stopped",
    });
    expect(readRefineStopAnswer({ outcome: "recorded" })).toEqual({
      outcome: "recorded",
    });
    expect(
      readRefineStopAnswer({
        outcome: "too_late",
        url: "https://storage.googleapis.com/bucket/stores/s/refined/r.webp",
      }),
    ).toEqual({
      outcome: "too_late",
      url: "https://storage.googleapis.com/bucket/stores/s/refined/r.webp",
    });
  });

  it("★ anything unrecognised is unknown, never stopped", () => {
    for (const value of [
      null,
      undefined,
      "stopped",
      ["stopped"],
      {},
      { outcome: "STOPPED" },
      { outcome: "acted" },
      { outcome: "unknown" },
      { error: "Couldn't stop that refine right now.", outcome: "maybe" },
    ]) {
      expect(readRefineStopAnswer(value)).toEqual({ outcome: "unknown" });
    }
  });

  it("★ keeps a too_late URL only when it is https and at most 2,048 characters", () => {
    const https = "https://storage.googleapis.com/b/x.webp";
    const longest = `https://${"a".repeat(2_048 - "https://".length)}`;
    expect(readRefineStopAnswer({ outcome: "too_late", url: longest })).toEqual(
      { outcome: "too_late", url: longest },
    );
    for (const url of [
      `${longest}a`,
      "http://storage.googleapis.com/b/x.webp",
      "javascript:alert(1)",
      "/relative.webp",
      42,
      null,
      undefined,
    ]) {
      expect(readRefineStopAnswer({ outcome: "too_late", url })).toEqual({
        outcome: "too_late",
        url: null,
      });
    }
    expect(readRefineStopAnswer({ outcome: "too_late", url: https })).toEqual({
      outcome: "too_late",
      url: https,
    });
  });
});

describe("REFINE_STOP_TOKEN_PATTERN", () => {
  it("accepts a random UUID in either case and nothing else", () => {
    const token = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    expect(REFINE_STOP_TOKEN_PATTERN.test(token)).toBe(true);
    expect(REFINE_STOP_TOKEN_PATTERN.test(token.toUpperCase())).toBe(true);
    expect(REFINE_STOP_TOKEN_PATTERN.test(crypto.randomUUID())).toBe(true);
    for (const bad of [
      "",
      "not-a-uuid",
      `${token} `,
      ` ${token}`,
      `${token}0`,
      "00000000-0000-0000-0000-000000000000",
      "3f2b8c1e-9a4d-4e6f-cb2a-1c3d5e7f9a0b",
      "3f2b8c1e9a4d4e6f8b2a1c3d5e7f9a0b",
    ]) {
      expect(REFINE_STOP_TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
