import { describe, expect, it } from "vitest";

import {
  isInvalidMediaAddress,
  isMediaKey,
  mediaKeyFromUrl,
  type MediaKeyConfig,
} from "./media-key";

const CONFIG: MediaKeyConfig = { bucket: "storemink-media" };
const OBJECT = "stores/11111111-2222-4333-8444-555555555555/uploads/shoe.webp";
const BUCKET_KEY = { source: "bucket", key: OBJECT };
const PLAIN = `https://storage.googleapis.com/storemink-media/${OBJECT}`;

function key(url: unknown, config: MediaKeyConfig = CONFIG) {
  return mediaKeyFromUrl(url, config);
}

describe("this bucket: every spelling of one object is one key", () => {
  const spellings = [
    PLAIN,
    // The dot of the extension written %2E.
    `https://storage.googleapis.com/storemink-media/${OBJECT.replace(".webp", "%2Ewebp")}`,
    // The slashes of the object name written %2F (Google decodes once).
    `https://storage.googleapis.com/storemink-media/${OBJECT.replace(/\//g, "%2F")}`,
    // Lower-case escapes, an upper-case host, a trailing dot, the default port.
    `https://storage.googleapis.com/storemink-media/${OBJECT.replace(".webp", "%2ewebp")}`,
    `https://STORAGE.GoogleApis.com/storemink-media/${OBJECT}`,
    `https://storage.googleapis.com./storemink-media/${OBJECT}`,
    `https://storage.googleapis.com:443/storemink-media/${OBJECT}`,
    // A query or fragment changes nothing.
    `${PLAIN}?ignoreCache=1#top`,
    // Wrapped by the optimiser or the share-image route, encoded as Next does.
    `/_next/image?url=${encodeURIComponent(PLAIN)}&w=640&q=75`,
    `/_next/image?w=640&amp;url=${encodeURIComponent(PLAIN)}`,
    `/api/og-image?url=${encodeURIComponent(PLAIN)}`,
    `https://shop.example.com/_next/image?url=${encodeURIComponent(PLAIN)}&w=1080`,
    // Plain http and protocol-relative addresses load the same picture.
    PLAIN.replace("https:", "http:"),
    PLAIN.replace("https:", ""),
    // The other addresses Google serves the same object at.
    `https://storemink-media.storage.googleapis.com/${OBJECT}`,
    `https://storage.googleapis.com/download/storage/v1/b/storemink-media/o/${encodeURIComponent(OBJECT)}?alt=media`,
    `https://www.googleapis.com/storage/v1/b/storemink-media/o/${encodeURIComponent(OBJECT)}?alt=media`,
    `https://commondatastorage.googleapis.com/storemink-media/${OBJECT}`,
    // Surrounding space and a stray line break.
    `  ${PLAIN.slice(0, 20)}\n${PLAIN.slice(20)}  `,
  ];
  for (const spelling of spellings) {
    it(spelling.slice(0, 90), () => {
      expect(key(spelling)).toEqual(BUCKET_KEY);
    });
  }

  it("a name encoded twice is a different object", () => {
    const twice = `https://storage.googleapis.com/storemink-media/${OBJECT.replace(".webp", "%252Ewebp")}`;
    expect(key(twice)).toEqual({
      source: "bucket",
      key: OBJECT.replace(".webp", "%2Ewebp"),
    });
  });

  it("keeps characters Google keeps literally", () => {
    expect(
      key("https://storage.googleapis.com/storemink-media/a+b%20c.jpg"),
    ).toEqual({ source: "bucket", key: "a+b c.jpg" });
  });

  it("the bucket name itself may be escaped", () => {
    expect(
      key(`https://storage.googleapis.com/storemink%2Dmedia/${OBJECT}`),
    ).toEqual(BUCKET_KEY);
  });
});

describe("refused: an address that cannot be read safely", () => {
  const refused = [
    // Dot segments, before or after decoding.
    "https://storage.googleapis.com/storemink-media/stores/../other.jpg",
    "https://storage.googleapis.com/storemink-media/stores/%2E%2E/other.jpg",
    "https://storage.googleapis.com/storemink-media/stores%2F..%2Fother.jpg",
    "https://storage.googleapis.com/storemink-media/./a.jpg",
    "https://cdn.example.com/a/../b.jpg",
    "https://cdn.example.com/a/%2e%2E/b.jpg",
    "/themes/basket/../../etc.webp",
    "/themes/basket/%2E%2E/x.webp",
    // Malformed escapes.
    "https://storage.googleapis.com/storemink-media/a%zz.jpg",
    "https://storage.googleapis.com/storemink-media/a%E0%A4.jpg",
    "https://cdn.example.com/a%2.jpg",
    "/themes/basket/a%2.webp",
    // A backslash, user information, an empty host.
    "https://storage.googleapis.com\\storemink-media/a.jpg",
    "https://user:pass@cdn.example.com/a.jpg",
    "https:///a.jpg",
    "https:/cdn.example.com/a.jpg",
    // A control character in an object name, or a name that reads as a path.
    "https://storage.googleapis.com/storemink-media/a%00.jpg",
    "https://storage.googleapis.com/storemink-media//a.jpg",
    "https://storage.googleapis.com/storemink-media/https%3A%2F%2Fx.jpg",
    // A wrapper inside a wrapper.
    `/_next/image?url=${encodeURIComponent(`/api/og-image?url=${encodeURIComponent(PLAIN)}`)}`,
    // A malformed escape inside a wrapped address.
    `/_next/image?url=${encodeURIComponent("https://storage.googleapis.com/storemink-media/a%zz.jpg")}`,
  ];
  for (const url of refused) {
    it(url.slice(0, 90), () => {
      expect(key(url)).toEqual({ invalid: true });
      expect(isInvalidMediaAddress(key(url))).toBe(true);
      expect(isMediaKey(key(url))).toBe(false);
    });
  }
});

describe("bundled theme images", () => {
  it("a /themes/ path is bundled, decoded once", () => {
    expect(key("/themes/basket/hero.webp")).toEqual({
      source: "bundled",
      key: "/themes/basket/hero.webp",
    });
    expect(key("/themes/basket/hero%2Ewebp?v=2")).toEqual({
      source: "bundled",
      key: "/themes/basket/hero.webp",
    });
    expect(
      key(
        `/_next/image?url=${encodeURIComponent("/themes/basket/hero.webp")}&w=640`,
      ),
    ).toEqual({ source: "bundled", key: "/themes/basket/hero.webp" });
  });

  it("anything else under /themes/ is not a bundled image", () => {
    expect(key("/themes/")).toBeNull();
    expect(key("/themes/basket/hero image.webp")).toBeNull();
  });
});

describe("outside addresses", () => {
  it("any other https host is external, keyed without its query", () => {
    expect(
      key("https://cdn.example.com/products/shoe.jpg?width=600#x"),
    ).toEqual({
      source: "external",
      key: "https://cdn.example.com/products/shoe.jpg",
    });
    expect(
      key("https://images.unsplash.com/photo-123?auto=format&fit=crop&w=1200"),
    ).toEqual({
      source: "external",
      key: "https://images.unsplash.com/photo-123",
    });
  });

  it("normalises the host, the port and the path the RFC 3986 way", () => {
    const one = {
      source: "external",
      key: "https://cdn.example.com/a/b%2Fc.jpg",
    };
    expect(key("https://CDN.Example.com/a/b%2fc.jpg")).toEqual(one);
    expect(key("https://cdn.example.com:443/a/b%2Fc.jpg")).toEqual(one);
    expect(key("http://cdn.example.com:80/a/b%2Fc.jpg")).toEqual(one);
    expect(key("//cdn.example.com/a/b%2Fc.jpg")).toEqual(one);
    expect(key("https://cdn.example.com/%61/b%2Fc.jpg")).toEqual(one);
    expect(key("https://cdn.example.com:8443/a.jpg")).toEqual({
      source: "external",
      key: "https://cdn.example.com:8443/a.jpg",
    });
    expect(key("https://cdn.example.com")).toEqual({
      source: "external",
      key: "https://cdn.example.com/",
    });
    expect(key("https://cdn.example.com/a b/é.jpg")).toEqual({
      source: "external",
      key: "https://cdn.example.com/a%20b/%C3%A9.jpg",
    });
  });

  it("another bucket on Google's host is not ours, so it is external", () => {
    expect(
      key("https://storage.googleapis.com/someone-else/stores/a.jpg"),
    ).toEqual({
      source: "external",
      key: "https://storage.googleapis.com/someone-else/stores/a.jpg",
    });
    expect(key("https://someone-else.storage.googleapis.com/a.jpg")).toEqual({
      source: "external",
      key: "https://someone-else.storage.googleapis.com/a.jpg",
    });
  });

  it("with no bucket configured nothing is a bucket key", () => {
    expect(key(PLAIN, { bucket: null })).toEqual({
      source: "external",
      key: PLAIN,
    });
    expect(key(PLAIN, { bucket: "  " })).toMatchObject({
      source: "external",
    });
  });
});

describe("not a media address at all", () => {
  for (const url of [
    null,
    undefined,
    42,
    "",
    "   ",
    "/shop/shoe",
    "shoe.jpg",
    "storage.googleapis.com/storemink-media/a.jpg",
    "data:image/png;base64,AAAA",
    "blob:https://shop.example.com/123",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "ftp://example.com/a.jpg",
    "/_next/image?w=640",
    "https://storage.googleapis.com/storemink-media/",
  ]) {
    it(String(url), () => {
      expect(key(url)).toBeNull();
    });
  }
});

describe("the three sources' keys never overlap", () => {
  it("bucket keys never look like a path or an address; bundled and external do", () => {
    const samples = [
      PLAIN,
      "https://storage.googleapis.com/storemink-media/https:foo.jpg",
      "/themes/basket/hero.webp",
      "https://cdn.example.com/a.jpg",
      "https://storage.googleapis.com/someone-else/a.jpg",
    ];
    for (const sample of samples) {
      const result = key(sample);
      expect(isMediaKey(result)).toBe(true);
      if (!isMediaKey(result)) continue;
      const k = result.key;
      if (result.source === "bucket") {
        expect(k).not.toMatch(/^\/|^https?:\//i);
      } else if (result.source === "bundled") {
        expect(k.startsWith("/themes/")).toBe(true);
      } else {
        expect(k.startsWith("https://")).toBe(true);
      }
    }
  });
});
