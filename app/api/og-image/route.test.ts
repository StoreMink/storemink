/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";

// The share-image route (takedown T7): an address is put in its normal form
// before the bucket check, an unreadable one is refused, and a blocked one is
// answered with the placeholder card and never fetched. No test reaches a
// database or the network: the bucket is fixed, the database refuses, fetch is
// a stub, and the blocked set is driven per test through `currentSet`.

vi.mock("@/lib/storage/gcs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    GCS_BUCKET_NAME: "sm-media",
    GCS_PUBLIC_HOST: "storage.googleapis.com",
  };
});
vi.mock("@/lib/db/client", () => {
  const refuse = vi.fn(async () => {
    throw new Error("no database in og-image tests");
  });
  return { withService: refuse, withAnon: refuse, withUser: refuse };
});
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "203.0.113.5"),
}));
let currentSet: any = null;
vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, blockedMedia: vi.fn(async () => currentSet) };
});
vi.mock("@/lib/moderation/placeholder", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, placeholderWebp: vi.fn(actual.placeholderWebp) };
});

import { GET } from "./route";
import { rateLimit } from "@/lib/rate-limit";
import {
  blockedMedia,
  buildBlockedMediaSet,
  type BlockedObjectRow,
} from "@/lib/moderation/blocked-objects";

const STORE = "a0000000-0000-4000-8000-000000000001";
const BUCKET = "https://storage.googleapis.com/sm-media";
const BLOCKED_OBJECT = `stores/${STORE}/media/a.webp`;
const BLOCKED_URL = `${BUCKET}/${BLOCKED_OBJECT}`;
const OK_URL = `${BUCKET}/stores/${STORE}/media/ok.webp`;
const BLOCKED_OUTSIDE = "https://cdn.example.com/x/bag.jpg";

function blockRow(objectPath: string, fileSource: string): BlockedObjectRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    objectPath,
    fileSource,
    storeId: STORE,
    objectMd5: null,
    tellStore: true,
  };
}

const EMPTY_SET = buildBlockedMediaSet([], { bucket: "sm-media", loadedAt: 1 });
const BLOCKING_SET = buildBlockedMediaSet(
  [
    blockRow(BLOCKED_OBJECT, "bucket"),
    blockRow(BLOCKED_OUTSIDE, "external"),
    blockRow("/themes/vitrine/hero.webp", "bundled"),
  ],
  { bucket: "sm-media", loadedAt: 1 },
);

let fetchMock: ReturnType<typeof vi.fn>;

function get(url: string | null) {
  const query = url === null ? "" : `?url=${encodeURIComponent(url)}`;
  return GET(new NextRequest(`https://storemink.com/api/og-image${query}`));
}

async function expectPlaceholderCard(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const body = Buffer.from(await res.arrayBuffer());
  expect([...body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  const meta = await sharp(body).metadata();
  expect(meta.format).toBe("jpeg");
  expect(meta.width).toBe(1200);
  expect(meta.height).toBe(630);
  expect(fetchMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  currentSet = EMPTY_SET;
  fetchMock = vi.fn(async () => {
    throw new Error("no network in og-image tests");
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("og-image: blocked pictures", () => {
  it("answers a blocked object with the placeholder card, never fetched or kept", async () => {
    currentSet = BLOCKING_SET;
    await expectPlaceholderCard(await get(BLOCKED_URL));
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ["an escaped dot", `${BUCKET}/stores/${STORE}/media/a%2Ewebp`],
    ["escaped slashes", `${BUCKET}/stores%2F${STORE}%2Fmedia%2Fa.webp`],
    [
      "a virtual-hosted bucket",
      `https://sm-media.storage.googleapis.com/${BLOCKED_OBJECT}`,
    ],
    ["plain http", `http://storage.googleapis.com/sm-media/${BLOCKED_OBJECT}`],
    [
      "an upper-case host",
      `https://STORAGE.googleapis.com/sm-media/${BLOCKED_OBJECT}`,
    ],
    ["a blocked outside address", BLOCKED_OUTSIDE],
    [
      "an optimiser wrapper",
      `/_next/image?url=${encodeURIComponent(BLOCKED_URL)}`,
    ],
  ])("catches %s", async (_label, url) => {
    currentSet = BLOCKING_SET;
    await expectPlaceholderCard(await get(url));
  });

  it("gives every response its own copy of the card", async () => {
    currentSet = BLOCKING_SET;
    const first = Buffer.from(await (await get(BLOCKED_URL)).arrayBuffer());
    const second = Buffer.from(await (await get(BLOCKED_URL)).arrayBuffer());
    expect(second.equals(first)).toBe(true);
  });

  it("answers 503 (never the file) when the card cannot be made, then recovers", async () => {
    // A fresh copy of the route, so no card is cached yet.
    vi.resetModules();
    const route = await import("./route");
    const placeholder = await import("@/lib/moderation/placeholder");
    vi.mocked(placeholder.placeholderWebp).mockRejectedValueOnce(
      new Error("disk"),
    );
    currentSet = BLOCKING_SET;
    const request = () =>
      route.GET(
        new NextRequest(
          `https://storemink.com/api/og-image?url=${encodeURIComponent(BLOCKED_URL)}`,
        ),
      );
    const failed = await request();
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
    // The failure was not kept: the next request makes the card.
    await expectPlaceholderCard(await request());
  });
});

describe("og-image: unreadable and foreign addresses", () => {
  it.each([
    ["a malformed escape", `${BUCKET}/stores/${STORE}/media/%E0%A4%A.webp`],
    ["a dot segment", `${BUCKET}/stores/${STORE}/../other/a.webp`],
    ["user information", `https://x@storage.googleapis.com/sm-media/a.webp`],
    ["a backslash", `${BUCKET}/stores\\${STORE}/media/a.webp`],
  ])("refuses %s with 400, before the set is read", async (_label, url) => {
    currentSet = BLOCKING_SET;
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid URL" });
    expect(blockedMedia).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a request with no url", async () => {
    const res = await get(null);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "https://cdn.example.com/x/ok.jpg"],
    [
      "another bucket",
      `https://storage.googleapis.com/other-bucket/${BLOCKED_OBJECT}`,
    ],
  ])("refuses %s with 403 and fetches nothing", async (_label, url) => {
    currentSet = BLOCKING_SET;
    const res = await get(url);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a relative address, as before, and fetches nothing", async () => {
    currentSet = BLOCKING_SET;
    const res = await get("/brand/20260908/storemink-mark.webp");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("og-image: an object of ours that is not blocked", () => {
  it("is fetched once and served as a cached share card", async () => {
    currentSet = BLOCKING_SET;
    const png = await sharp({
      create: {
        width: 1600,
        height: 900,
        channels: 3,
        background: { r: 200, g: 40, b: 40 },
      },
    })
      .png()
      .toBuffer();
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(png), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const res = await get(OK_URL);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OK_URL);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    );
    expect(res.headers.get("cdn-cache-control")).toBe("public, max-age=86400");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });

  it("fetches it while nothing is blocked", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const res = await get(BLOCKED_URL);
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
