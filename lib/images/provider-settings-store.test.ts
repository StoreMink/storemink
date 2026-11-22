/* eslint-disable @typescript-eslint/no-explicit-any */
// Which provider draws: the operator's choice, and never a reason for a job
// to fail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => logger);
const dbHolder = vi.hoisted(() => ({ current: null as any, fail: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    if (dbHolder.fail) throw new Error("db down");
    return fn(dbHolder.current.db);
  }),
}));

import {
  elevenLabsApiKey,
  elevenLabsKeyIsExclusive,
  getImageGenerationSettings,
  resolveImageProvider,
} from "./provider-settings-store";

function seed(row: Record<string, unknown> | null) {
  dbHolder.current = makeDbMock({ selectQueue: [row ? [row] : []] });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.fail = false;
});

describe("getImageGenerationSettings", () => {
  it("reads the operator's row", async () => {
    seed({ provider: "elevenlabs", quality: "medium", resolution: "2K" });
    expect(await getImageGenerationSettings()).toEqual({
      provider: "elevenlabs",
      elevenlabsQuality: "medium",
      elevenlabsResolution: "2K",
    });
  });

  it("★★ a failed read, a missing row or a value it does not know is the default: Google, low, 1K", async () => {
    const DEFAULT = {
      provider: "google",
      elevenlabsQuality: "low",
      elevenlabsResolution: "1K",
    };
    seed(null);
    expect(await getImageGenerationSettings()).toEqual(DEFAULT);
    seed({ provider: "openai", quality: "max", resolution: "4K" });
    expect(await getImageGenerationSettings()).toEqual(DEFAULT);
    dbHolder.fail = true;
    expect(await getImageGenerationSettings()).toEqual(DEFAULT);
  });
});

describe("the key", () => {
  it("is read from ELEVENLABS_API_KEY, and blank means none", () => {
    expect(elevenLabsApiKey({ ELEVENLABS_API_KEY: " sk_x " })).toBe("sk_x");
    expect(elevenLabsApiKey({ ELEVENLABS_API_KEY: "  " })).toBeNull();
    expect(elevenLabsApiKey({})).toBeNull();
  });
});

describe("whether the key is this environment's alone", () => {
  it("★★ is false unless ELEVENLABS_KEY_EXCLUSIVE says true: the safe side is the default", () => {
    expect(elevenLabsKeyIsExclusive({})).toBe(false);
    expect(elevenLabsKeyIsExclusive({ ELEVENLABS_KEY_EXCLUSIVE: "" })).toBe(
      false,
    );
    expect(elevenLabsKeyIsExclusive({ ELEVENLABS_KEY_EXCLUSIVE: "1" })).toBe(
      false,
    );
    expect(
      elevenLabsKeyIsExclusive({ ELEVENLABS_KEY_EXCLUSIVE: "false" }),
    ).toBe(false);
    expect(
      elevenLabsKeyIsExclusive({ ELEVENLABS_KEY_EXCLUSIVE: " True " }),
    ).toBe(true);
  });
});

describe("resolveImageProvider: the provider that will really draw", () => {
  it("ElevenLabs when it is chosen and this environment holds its key", async () => {
    seed({ provider: "elevenlabs", quality: "low", resolution: "1K" });
    expect(
      (await resolveImageProvider({ ELEVENLABS_API_KEY: "sk_x" })).provider,
    ).toBe("elevenlabs");
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it("★★ chosen but with no key: Google draws, and the log says why", async () => {
    seed({ provider: "elevenlabs", quality: "medium", resolution: "2K" });
    const settings = await resolveImageProvider({});
    expect(settings).toEqual({
      provider: "google",
      elevenlabsQuality: "medium",
      elevenlabsResolution: "2K",
    });
    expect(logger.logWarn).toHaveBeenCalledTimes(1);
  });

  it("Google when Google is chosen, whatever keys exist", async () => {
    seed({ provider: "google", quality: "low", resolution: "1K" });
    expect(
      (await resolveImageProvider({ ELEVENLABS_API_KEY: "sk_x" })).provider,
    ).toBe("google");
  });
});
