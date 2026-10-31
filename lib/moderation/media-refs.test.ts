import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MEDIA_URL_RE,
  findAddresses,
  mightHoldMediaAddress,
  referencedMediaKeys,
} from "./media-refs";

const CONFIG = { bucket: "storemink-media" };
const A =
  "https://storage.googleapis.com/storemink-media/stores/s1/uploads/a.webp";
const B =
  "https://storage.googleapis.com/storemink-media/stores/s1/uploads/b.webp";
const C =
  "https://storage.googleapis.com/storemink-media/stores/s1/uploads/c.webp";

function bucket(name: string) {
  return { source: "bucket", key: `stores/s1/uploads/${name}` };
}

describe("MEDIA_URL_RE is the store purge's own pattern", () => {
  // platform.ts defines it until stage T17 imports it from here; while it
  // still has its own copy the two must be the same, and once it imports it
  // the import must name this module.
  const PLATFORM = readFileSync("app/actions/platform.ts", "utf8");

  it("matches app/actions/platform.ts", () => {
    const own = /const MEDIA_URL_RE =\s*(\/.+\/)([a-z]*);/.exec(PLATFORM);
    if (own) {
      expect(own[1]).toBe(`/${MEDIA_URL_RE.source}/`);
      expect(own[2]).toBe(MEDIA_URL_RE.flags);
    } else {
      expect(PLATFORM).toMatch(
        /import\s*\{[^}]*\bMEDIA_URL_RE\b[^}]*\}\s*from\s*["']@\/lib\/moderation\/media-refs["']/,
      );
    }
  });

  it("finds bucket addresses in a JSON-encoded row and stops at a backslash", () => {
    const row = JSON.stringify({ html: `<img src="${A}">`, list: [B] });
    expect(row.match(MEDIA_URL_RE)).toEqual([A, B]);
  });
});

describe("findAddresses", () => {
  it("finds addresses in nested JSON text", () => {
    const text = JSON.stringify({
      image_url: A,
      sections: [{ config: { items: [{ image_url: B }] } }],
    });
    expect(findAddresses(text).map((f) => f.address)).toEqual([A, B]);
  });

  it("finds src and srcset values in HTML and marks them as markup", () => {
    const html = `<p>See <a href="https://example.com/about">us</a></p><img src="${A}" srcset="${B} 1x, ${C} 2x">`;
    const found = findAddresses(html);
    expect(found.map((f) => [f.address, f.inMarkup])).toEqual([
      ["https://example.com/about", false],
      [A, true],
      [B, true],
      [C, true],
    ]);
    for (const f of found) expect(html.slice(f.start, f.end)).toBe(f.address);
  });

  it("reads JSON-escaped and single-quoted attributes, poster, data-src and CSS url()", () => {
    const text = JSON.stringify(
      `<video poster='${A}'></video><img data-src="${B}"><div style="background:url(${C})">`,
    );
    expect(findAddresses(text).map((f) => [f.address, f.inMarkup])).toEqual([
      [A, true],
      [B, true],
      [C, true],
    ]);
  });

  it("finds wrapped, protocol-relative and bundled addresses where a value starts", () => {
    const wrapped = `/_next/image?url=${encodeURIComponent(A)}&w=640`;
    const text = `<img src="${wrapped}"> <img src="//cdn.example.com/x.jpg"> "/themes/basket/hero.webp"`;
    expect(findAddresses(text).map((f) => f.address)).toEqual([
      wrapped,
      "//cdn.example.com/x.jpg",
      "/themes/basket/hero.webp",
    ]);
    // Not in the middle of a path.
    expect(findAddresses("see docs/themes/basket.webp and a//b")).toEqual([]);
  });

  it("ends an address at quotes, brackets, entities and trailing punctuation", () => {
    const text = `Look: ${A}. And (${B}), also &quot;${C}&quot; then ${A}&gt;`;
    expect(findAddresses(text).map((f) => f.address)).toEqual([A, B, C, A]);
  });

  it("finds nothing in text without an address", () => {
    expect(
      findAddresses("Plain words, a price of 499 and a date 30/10."),
    ).toEqual([]);
    expect(findAddresses("https://")).toEqual([]);
  });

  it("mightHoldMediaAddress is a cheap first look", () => {
    expect(mightHoldMediaAddress("no address here")).toBe(false);
    expect(mightHoldMediaAddress(`x ${A}`)).toBe(true);
    expect(mightHoldMediaAddress("/themes/basket/a.webp")).toBe(true);
    expect(mightHoldMediaAddress("/_next/image?url=x")).toBe(true);
    expect(mightHoldMediaAddress("/api/og-image?url=x")).toBe(true);
  });
});

describe("referencedMediaKeys", () => {
  it("walks nested objects, arrays and HTML, first seen first, each once", () => {
    const row = {
      image_url: A,
      images: [B, A],
      description: `<p>Our shoe.</p><img src="${C}" srcset="${C} 2x">`,
      sections: [
        { type: "hero", config: { image_url: "/themes/basket/hero.webp" } },
        { type: "gallery", config: { items: [{ image_url: B }] } },
      ],
    };
    expect(referencedMediaKeys(row, CONFIG)).toEqual([
      bucket("a.webp"),
      bucket("b.webp"),
      bucket("c.webp"),
      { source: "bundled", key: "/themes/basket/hero.webp" },
    ]);
  });

  it("one object under different spellings is one key", () => {
    const row = [
      A,
      A.replace(".webp", "%2Ewebp"),
      `/_next/image?url=${encodeURIComponent(A)}&w=640`,
    ];
    expect(referencedMediaKeys(row, CONFIG)).toEqual([bucket("a.webp")]);
  });

  it("an outside address counts only where it is clearly a picture", () => {
    const row = {
      cta_href: "https://instagram.com/our-shop",
      body: "Read https://example.com/blog/post for more.",
      image_url: "https://cdn.example.com/products/shoe.jpg?w=600",
      photo: "https://images.unsplash.com/photo-123?auto=format",
      html: `<img src="https://lh3.example.com/abc">`,
    };
    expect(referencedMediaKeys(row, CONFIG)).toEqual([
      { source: "external", key: "https://cdn.example.com/products/shoe.jpg" },
      { source: "external", key: "https://images.unsplash.com/photo-123" },
      { source: "external", key: "https://lh3.example.com/abc" },
    ]);
  });

  it("leaves out addresses that cannot be read safely", () => {
    const row = [
      "https://storage.googleapis.com/storemink-media/stores/%2E%2E/x.jpg",
      A,
    ];
    expect(referencedMediaKeys(row, CONFIG)).toEqual([bucket("a.webp")]);
  });

  it("survives a value that refers to itself and ignores non-text values", () => {
    const row: Record<string, unknown> = {
      image_url: A,
      n: 3,
      at: new Date(),
      x: null,
    };
    row.self = row;
    row.list = [row, { deeper: [B] }];
    expect(referencedMediaKeys(row, CONFIG)).toEqual([
      bucket("a.webp"),
      bucket("b.webp"),
    ]);
    expect(referencedMediaKeys(null, CONFIG)).toEqual([]);
    expect(referencedMediaKeys(42, CONFIG)).toEqual([]);
  });
});
