import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The public tax source (GST design 5.11): the cached read the pricing pages
 * use. The cache is a stand-in that behaves like Next's in the two ways that
 * matter here: it stores only a value the read returned, and it throws when
 * there is no render or request scope.
 */
const h = vi.hoisted(() => ({
  registered: [] as {
    keys: string[];
    opts: { tags?: string[]; revalidate?: number };
  }[],
  cached: undefined as unknown,
  noScope: false,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: () => Promise<unknown>,
    keys: string[],
    opts: { tags?: string[]; revalidate?: number },
  ) => {
    h.registered.push({ keys, opts });
    return async () => {
      if (h.noScope) {
        throw new Error(
          "Invariant: incrementalCache missing in unstable_cache () => readTaxTermsSource()",
        );
      }
      if (h.cached !== undefined) return h.cached;
      const value = await fn();
      h.cached = value;
      return value;
    };
  },
}));

vi.mock("./platform-settings", () => ({
  PLATFORM_TAX_TAG: "platform-tax",
  bustPlatformTax: vi.fn(),
  getTaxTermsLive: vi.fn(),
  readTaxTermsSource: vi.fn(),
}));

import * as settings from "./platform-settings";
import {
  PLATFORM_TAX_TAG,
  PUBLIC_TAX_CACHE_KEY,
  PUBLIC_TAX_REVALIDATE_SECONDS,
  bustPlatformTax,
  getPublicTaxSource,
  getTaxTermsLive,
} from "./public-tax";
import type { TaxTermsSource } from "./tax-terms";

const SOURCE: TaxTermsSource = {
  taxEnabled: false,
  taxInclusive: false,
  taxRateBps: 1800,
  nextTaxEnabled: true,
  nextTaxInclusive: false,
  nextTaxRateBps: 1800,
  nextTaxStartsAt: "2026-12-10T09:30:00.000Z",
};

beforeEach(() => {
  h.cached = undefined;
  h.noScope = false;
  vi.mocked(settings.readTaxTermsSource).mockResolvedValue(SOURCE);
});

describe("getPublicTaxSource", () => {
  it("★ is cached under one key and the tag `platform-tax`, for 300 seconds", () => {
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0].keys).toEqual(["platform-tax-terms"]);
    expect(h.registered[0].opts).toEqual({
      tags: ["platform-tax"],
      revalidate: 300,
    });
    expect(PUBLIC_TAX_CACHE_KEY).toBe("platform-tax-terms");
    expect(PUBLIC_TAX_REVALIDATE_SECONDS).toBe(300);
    expect(PLATFORM_TAX_TAG).toBe("platform-tax");
  });

  it("returns the seven tax columns the read gives it", async () => {
    expect(await getPublicTaxSource()).toEqual(SOURCE);
    expect(settings.readTaxTermsSource).toHaveBeenCalledTimes(1);
  });

  it("serves a second request from the cache", async () => {
    await getPublicTaxSource();
    await getPublicTaxSource();
    expect(settings.readTaxTermsSource).toHaveBeenCalledTimes(1);
  });

  it("★★ a read failure throws and is never cached, so the next request reads again", async () => {
    vi.mocked(settings.readTaxTermsSource).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(getPublicTaxSource()).rejects.toThrow("db down");
    expect(await getPublicTaxSource()).toEqual(SOURCE);
    expect(settings.readTaxTermsSource).toHaveBeenCalledTimes(2);
  });

  it("★ outside a render or request, it reads live instead of failing", async () => {
    h.noScope = true;
    expect(await getPublicTaxSource()).toEqual(SOURCE);
    expect(settings.readTaxTermsSource).toHaveBeenCalledTimes(1);
  });

  it("outside a scope, a failed live read still throws", async () => {
    h.noScope = true;
    vi.mocked(settings.readTaxTermsSource).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(getPublicTaxSource()).rejects.toThrow("db down");
  });
});

describe("what the module re-exports", () => {
  it("the bust and the live read are the platform settings' own", () => {
    expect(bustPlatformTax).toBe(settings.bustPlatformTax);
    expect(getTaxTermsLive).toBe(settings.getTaxTermsLive);
  });
});
