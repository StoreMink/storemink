import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({ GCS_BUCKET_NAME: "sm-media" }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import {
  type BlockedObjectRow,
  buildBlockedMediaSet,
  isBlockedAddressIn,
  maskBlockedMedia,
  maskBlockedMediaWith,
} from "./blocked-objects";
import { PLACEHOLDER_URL_PATH } from "./placeholder";

const STATE_KEY = Symbol.for("storemink.moderation.blockedObjects");
const STORE = "a0000000-0000-4000-8000-000000000001";
const P = PLACEHOLDER_URL_PATH;
const BUCKET_URL = "https://storage.googleapis.com/sm-media";
const BLOCKED = `${BUCKET_URL}/stores/${STORE}/media/a.webp`;
const OK = `${BUCKET_URL}/stores/${STORE}/media/ok.webp`;

function row(objectPath: string, fileSource = "bucket"): BlockedObjectRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    objectPath,
    fileSource,
    storeId: STORE,
    objectMd5: null,
    tellStore: true,
  };
}

const SET = buildBlockedMediaSet(
  [
    row(`stores/${STORE}/media/a.webp`),
    row("https://cdn.example.com/x/bag.jpg", "external"),
    row("/themes/vitrine/hero.webp", "bundled"),
  ],
  { bucket: "sm-media", loadedAt: 1 },
);
const BUCKET_ONLY = buildBlockedMediaSet(
  [row(`stores/${STORE}/media/a.webp`)],
  { bucket: "sm-media", loadedAt: 1 },
);
const EMPTY = buildBlockedMediaSet([], { bucket: "sm-media", loadedAt: 1 });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A value that throws when anything inside it is read. `then` alone answers
 * undefined: resolving a promise with an object always asks for it.
 */
function untouchable(): object {
  const fail = () => {
    throw new Error("the value was walked");
  };
  return new Proxy(
    {},
    {
      get: (_target, key) => (key === "then" ? undefined : fail()),
      has: fail,
      ownKeys: fail,
      getPrototypeOf: fail,
      getOwnPropertyDescriptor: fail,
    },
  );
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("maskBlockedMediaWith: where an address is swapped", () => {
  it("swaps a whole string and leaves another address alone", () => {
    expect(maskBlockedMediaWith(BLOCKED, SET)).toBe(P);
    expect(maskBlockedMediaWith(OK, SET)).toBe(OK);
  });

  it("swaps HTML src and srcset values, keeping the rest of the markup", () => {
    const html = `<p>Hi</p><img src="${BLOCKED}" srcset="${BLOCKED} 1x, ${OK} 2x" alt="a">`;
    expect(maskBlockedMediaWith(html, SET)).toBe(
      `<p>Hi</p><img src="${P}" srcset="${P} 1x, ${OK} 2x" alt="a">`,
    );
  });

  it("swaps an address inside JSON-LD and a CSS url()", () => {
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      image: [BLOCKED, OK],
    });
    expect(maskBlockedMediaWith(jsonLd, SET)).toBe(
      JSON.stringify({ "@context": "https://schema.org", image: [P, OK] }),
    );
    expect(maskBlockedMediaWith(`.hero{background:url(${BLOCKED})}`, SET)).toBe(
      `.hero{background:url(${P})}`,
    );
  });

  it("swaps JSON written with escaped slashes", () => {
    const escaped = `{"image":"${BLOCKED.replace(/\//g, "\\/")}"}`;
    expect(maskBlockedMediaWith(escaped, SET)).toBe(
      `{"image":"${P.replace(/\//g, "\\/")}"}`,
    );
  });

  it("swaps every spelling of the blocked object", () => {
    const spellings = [
      `${BUCKET_URL}/stores/${STORE}/media/a%2Ewebp`,
      `${BUCKET_URL}/stores%2F${STORE}%2Fmedia%2Fa.webp`,
      `https://sm-media.storage.googleapis.com/stores/${STORE}/media/a.webp?v=2`,
      `http://storage.googleapis.com/sm-media/stores/${STORE}/media/a.webp`,
      `/_next/image?url=${encodeURIComponent(BLOCKED)}&w=640&q=75`,
      `https://shop.example.com/_next/image?url=${encodeURIComponent(BLOCKED)}&amp;w=640`,
    ];
    for (const spelling of spellings) {
      expect(maskBlockedMediaWith(`<img src="${spelling}">`, SET)).toBe(
        `<img src="${P}">`,
      );
    }
    expect(
      maskBlockedMediaWith(
        `<img src="//storage.googleapis.com/sm-media/stores/${STORE}/media/a.webp">`,
        SET,
      ),
    ).toBe(`<img src="${P}">`);
  });

  it("swaps a blocked outside address (any host) and a bundled theme file", () => {
    expect(
      maskBlockedMediaWith("https://CDN.example.com/x/bag.jpg?w=200", SET),
    ).toBe(P);
    expect(
      maskBlockedMediaWith("https://cdn.example.com/x/other.jpg", SET),
    ).toBe("https://cdn.example.com/x/other.jpg");
    expect(
      maskBlockedMediaWith(`<img src="/themes/vitrine/hero.webp">`, SET),
    ).toBe(`<img src="${P}">`);
    expect(
      maskBlockedMediaWith(
        "https://shop.example.com/themes/vitrine/hero.webp",
        SET,
      ),
    ).toBe(P);
  });

  it("walks nested objects and arrays, and never changes object keys", () => {
    const value = {
      sections: [
        {
          type: "hero",
          config: { slides: [{ image_url: BLOCKED }, { image_url: OK }] },
        },
      ],
      [BLOCKED]: "key stays",
    };
    const masked = maskBlockedMediaWith(value, SET);
    expect(masked.sections[0].config.slides[0].image_url).toBe(P);
    expect(masked.sections[0].config.slides[1].image_url).toBe(OK);
    expect(masked[BLOCKED]).toBe("key stays");
  });

  it("keeps a Date, a Map and other non-plain values as they are", () => {
    const date = new Date(0);
    const map = new Map([["a", BLOCKED]]);
    const masked = maskBlockedMediaWith(
      { date, map, n: 3, b: true, x: null },
      SET,
    );
    expect(masked.date).toBe(date);
    expect(masked.map).toBe(map);
    expect(masked.n).toBe(3);
  });
});

describe("maskBlockedMediaWith: what it never does", () => {
  it("returns the very same value without walking it when nothing is blocked", () => {
    const value = untouchable();
    expect(maskBlockedMediaWith(value, EMPTY)).toBe(value);
    expect(maskBlockedMediaWith(BLOCKED, EMPTY)).toBe(BLOCKED);
  });

  it("returns the very same value when nothing in it is blocked", () => {
    const value = { a: [OK, { b: OK }], c: "text" };
    expect(maskBlockedMediaWith(value, SET)).toBe(value);
  });

  it("never mutates its input", () => {
    const input = {
      products: [
        {
          image_url: BLOCKED,
          images: [BLOCKED, OK],
          body: `<img src="${BLOCKED}">`,
        },
        { image_url: OK },
      ],
      shared: { logo: BLOCKED },
    };
    const before = structuredClone(input);
    deepFreeze(input);
    const masked = maskBlockedMediaWith(input, SET);
    expect(input).toEqual(before);
    expect(masked).not.toBe(input);
    expect(masked.products[0].images).toEqual([P, OK]);
  });

  it("shares every part with nothing to swap, and masks a shared part once", () => {
    const untouched = { a: OK };
    const shared = { logo: BLOCKED };
    const input = { untouched, one: shared, two: shared, list: [untouched] };
    const masked = maskBlockedMediaWith(input, SET);
    expect(masked.untouched).toBe(untouched);
    expect(masked.list).toBe(input.list);
    expect(masked.one).not.toBe(shared);
    expect(masked.one).toBe(masked.two);
    expect(masked.one.logo).toBe(P);
  });

  it("copies a cycle as a cycle and stops", () => {
    const input: Record<string, unknown> = { logo: BLOCKED, inner: {} };
    (input.inner as Record<string, unknown>).back = input;
    input.self = input;
    const masked = maskBlockedMediaWith(input, SET);
    expect(masked).not.toBe(input);
    expect(masked.logo).toBe(P);
    expect(masked.self).toBe(masked);
    expect((masked.inner as Record<string, unknown>).back).toBe(masked);
    expect(input.logo).toBe(BLOCKED);
    expect(input.self).toBe(input);
  });
});

describe("unreadable addresses", () => {
  it("swaps one that could name a blocked object once a browser normalises it", () => {
    const risky = [
      `${BUCKET_URL}/stores/${STORE}/media/../media/a.webp`,
      "https://cdn.example.com/x/../x/bag.jpg",
      "https://user@cdn.example.com/x/bag.jpg",
      "/themes/vitrine/../vitrine/hero.webp",
      `/_next/image?url=${encodeURIComponent(`${BUCKET_URL}/stores/${STORE}/x/../media/a.webp`)}`,
      `/_next/image?url=${encodeURIComponent(`/_next/image?url=${encodeURIComponent(OK)}`)}`,
      "https://[unreadable/a.jpg",
    ];
    for (const address of risky) {
      expect(isBlockedAddressIn(SET, address), address).toBe(true);
      expect(maskBlockedMediaWith(`<img src="${address}">`, SET)).toBe(
        `<img src="${P}">`,
      );
    }
  });

  it("leaves one that cannot name anything blocked", () => {
    const harmless = [
      "https://other.example.org/a/../b.jpg",
      "https://other.example.org/50%off.jpg",
    ];
    for (const address of harmless) {
      expect(isBlockedAddressIn(SET, address), address).toBe(false);
    }
    // No bundled block: an unreadable /themes/ path is left alone.
    expect(isBlockedAddressIn(BUCKET_ONLY, "/themes/a/../a/b.webp")).toBe(
      false,
    );
    // No outside block: an unreadable outside address is left alone.
    expect(
      isBlockedAddressIn(BUCKET_ONLY, "https://cdn.example.com/x/../y.jpg"),
    ).toBe(false);
  });
});

describe("maskBlockedMedia", () => {
  it("reads the process-wide set and swaps with it", async () => {
    vi.mocked(withService).mockImplementation(async (fn) =>
      fn(
        makeDbMock({
          selectByTable: {
            content_blocks: [[row(`stores/${STORE}/media/a.webp`)]],
          },
        }).db,
      ),
    );
    const masked = await maskBlockedMedia({ image_url: BLOCKED, other: OK });
    expect(masked).toEqual({ image_url: P, other: OK });
  });

  it("returns the very same value without walking it when nothing is blocked", async () => {
    vi.mocked(withService).mockImplementation(async (fn) =>
      fn(makeDbMock({ selectByTable: { content_blocks: [[]] } }).db),
    );
    const value = untouchable();
    expect(await maskBlockedMedia(value)).toBe(value);
  });
});
