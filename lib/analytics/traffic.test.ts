import { describe, expect, it } from "vitest";
import {
  classifyTrafficSource,
  cleanUtm,
  deviceTypeFromUserAgent,
  geoFromHeaders,
  referrerHostFrom,
  regionDisplayName,
} from "./traffic";

describe("storefront traffic attribution", () => {
  it("derives the device type, tablet before mobile", () => {
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe("tablet");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36",
      ),
    ).toBe("mobile");
    expect(
      deviceTypeFromUserAgent("Mozilla/5.0 (Linux; Android 13; SM-X710)"),
    ).toBe("tablet");
    expect(
      deviceTypeFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15",
      ),
    ).toBe("desktop");
  });

  it("keeps only the referring host and ignores the store itself", () => {
    expect(
      referrerHostFrom("https://www.google.co.in/search?q=x", "shop.example"),
    ).toBe("google.co.in");
    expect(
      referrerHostFrom("https://shop.example/cart", "shop.example:443"),
    ).toBeNull();
    expect(referrerHostFrom("android-app://com.x", "shop.example")).toBeNull();
    expect(referrerHostFrom(42, "shop.example")).toBeNull();
  });

  it("classifies sessions like Shopify's channel groups", () => {
    const c = (
      referrerHost: string | null,
      utmSource: string | null = null,
      utmMedium: string | null = null,
      paidClickId = false,
    ) =>
      classifyTrafficSource({
        referrerHost,
        utmSource,
        utmMedium,
        paidClickId,
      });
    expect(c(null)).toBe("direct");
    expect(c("google.com")).toBe("search");
    expect(c("instagram.com")).toBe("social");
    expect(c("wa.me")).toBe("social");
    expect(c("mail.google.com")).toBe("email");
    expect(c("someblog.in")).toBe("referral");
    expect(c("instagram.com", "instagram", "cpc")).toBe("paid");
    expect(c("google.com", null, null, true)).toBe("paid");
    expect(c(null, "newsletter", null)).toBe("email");
    expect(c(null, "partner", null)).toBe("referral");
  });

  it("bounds campaign tags", () => {
    expect(cleanUtm("  Diwali\u0000 Sale ")).toBe("Diwali Sale");
    expect(cleanUtm("x".repeat(300))?.length).toBe(100);
    expect(cleanUtm("   ")).toBeNull();
  });

  it("reads approximate location only when the load balancer sends it", () => {
    expect(geoFromHeaders(new Headers())).toEqual({
      country: null,
      region: null,
      city: null,
    });
    expect(
      geoFromHeaders(
        new Headers({
          "x-sm-geo-country": "in",
          "x-sm-geo-region": "INKA",
          "x-sm-geo-city": "Bengaluru",
        }),
      ),
    ).toEqual({ country: "IN", region: "KA", city: "Bengaluru" });
    expect(regionDisplayName("IN", "KA")).toBe("Karnataka");
    expect(regionDisplayName("US", "CA")).toBe("CA, United States");
  });
});
