import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STOREFRONT_PASSWORD_LENGTH,
  generateStorefrontPassword,
  signStorefrontGrant,
  storefrontGrantsConfigured,
  storefrontPasswordMatches,
  verifyStorefrontGrant,
} from "./storefront-grant";

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.STOREFRONT_PASSWORD_SECRET;
  process.env.CRON_SECRET = "cron-secret-for-tests";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("storefront grant", () => {
  it("round-trips the store id and password version", () => {
    const token = signStorefrontGrant({ storeId: "store-1", version: 3 });
    expect(verifyStorefrontGrant(token)).toMatchObject({
      t: "storefront-pass",
      sid: "store-1",
      v: 3,
    });
  });

  it("refuses a tampered payload, a foreign signature and an expired grant", () => {
    const token = signStorefrontGrant({ storeId: "store-1", version: 1 });
    const [payload, sig] = token.split(".");
    // Flip the store id inside the payload: the signature no longer matches.
    const forged =
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, "base64url").toString()),
          sid: "store-2",
        }),
      ).toString("base64url") +
      "." +
      sig;
    expect(verifyStorefrontGrant(forged)).toBeNull();
    expect(verifyStorefrontGrant(payload + ".AAAA")).toBeNull();
    expect(verifyStorefrontGrant("")).toBeNull();
    expect(verifyStorefrontGrant(undefined)).toBeNull();

    const now = Date.now();
    const short = signStorefrontGrant({ storeId: "s", version: 1 }, now, 10);
    expect(verifyStorefrontGrant(short, now + 11_000)).toBeNull();
    expect(verifyStorefrontGrant(short, now + 9_000)).not.toBeNull();
  });

  it("★ is keyed separately from CRON_SECRET itself and from the Studio preview key", () => {
    // A token signed with the raw CRON_SECRET must not verify: the grant key is
    // DERIVED with a purpose label, so neither can be replayed as the other.
    const payload = Buffer.from(
      JSON.stringify({
        t: "storefront-pass",
        sid: "s",
        v: 1,
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString("base64url");
    const rawMac = createHmac("sha256", "cron-secret-for-tests")
      .update(payload)
      .digest("base64url");
    expect(verifyStorefrontGrant(`${payload}.${rawMac}`)).toBeNull();
  });

  it("is unconfigured with no key at all, and prefers the explicit secret", () => {
    delete process.env.CRON_SECRET;
    expect(storefrontGrantsConfigured()).toBe(false);
    expect(() => signStorefrontGrant({ storeId: "s", version: 1 })).toThrow();
    expect(verifyStorefrontGrant("a.b")).toBeNull();

    process.env.STOREFRONT_PASSWORD_SECRET = "explicit";
    expect(storefrontGrantsConfigured()).toBe(true);
    const token = signStorefrontGrant({ storeId: "s", version: 1 });
    expect(verifyStorefrontGrant(token)?.sid).toBe("s");
  });
});

describe("storefront password", () => {
  it("generates an 8-character code with no look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStorefrontPassword();
      expect(pw).toHaveLength(STOREFRONT_PASSWORD_LENGTH);
      expect(pw).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
    }
  });

  it("compares case-insensitively and ignores surrounding whitespace, never empties", () => {
    expect(storefrontPasswordMatches("  AbC23xyz ", "abc23xyz")).toBe(true);
    expect(storefrontPasswordMatches("abc23xyz", "abc23xy")).toBe(false);
    expect(storefrontPasswordMatches("", "")).toBe(false);
    expect(storefrontPasswordMatches(null, "abc")).toBe(false);
    expect(storefrontPasswordMatches("abc", null)).toBe(false);
  });
});
