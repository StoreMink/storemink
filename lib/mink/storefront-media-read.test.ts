import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { BlockedMediaSet } from "@/lib/moderation/blocked-objects";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  blockedSet: null as BlockedMediaSet | null,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) =>
    run({ execute: mocks.execute }),
  ),
}));

vi.mock("@/lib/moderation/blocked-objects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/moderation/blocked-objects")>();
  return {
    ...actual,
    blockedMedia: vi.fn(
      async () => mocks.blockedSet ?? actual.emptyBlockedMediaSet(1, "b"),
    ),
  };
});

import { withService } from "@/lib/db/client";
import {
  blockedMedia,
  buildBlockedMediaSet,
} from "@/lib/moderation/blocked-objects";
import {
  readMinkStorefrontMedia,
  readOwnedStorefrontImageUrls,
  selectBlockedImageUrls,
  selectOwnedStorefrontImageUrls,
} from "./storefront-media-read";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "designer",
  permissions: { media: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
  runId: "run-1",
  draftingEnabled: false,
};

function row(n: number) {
  return {
    id: `id-${n}`,
    url: `https://storage.googleapis.com/b/stores/store-1/media/${n}.webp`,
    filename: `photo-${n}.jpg`,
    content_type: "image/webp",
    size_bytes: 2048,
    created_at: "2026-09-12 10:00:00+00",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GCS_BUCKET", "b");
  mocks.blockedSet = null;
  mocks.execute.mockResolvedValue({ rows: [row(1), row(2)] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A live file block on each of these stored keys. */
function blockedSet(...paths: string[]): BlockedMediaSet {
  return buildBlockedMediaSet(
    paths.map((path, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      objectPath: path,
      fileSource: path.startsWith("/themes/")
        ? "bundled"
        : path.startsWith("https://")
          ? "external"
          : "bucket",
      storeId: "store-1",
      objectMd5: null,
      tellStore: i % 2 === 0,
    })),
    { bucket: "b", loadedAt: 1 },
  );
}

function compiled(call = 0) {
  return new PgDialect().sqlToQuery(mocks.execute.mock.calls[call][0]);
}

describe("Phase 9D media library read", () => {
  it("returns the exact URLs a proposal must echo, scoped to the trusted store", async () => {
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media).toHaveLength(2);
    expect(result.media[0]).toMatchObject({
      mediaId: "id-1",
      url: row(1).url,
      filename: "photo-1.jpg",
      sizeBytes: 2048,
    });
    expect(result.scope).toBe("current_store");
    expect(result.contentTrust).toBe("untrusted_storefront_data");
    expect(result.usage).toContain(
      "catalogue image returned by search_products",
    );

    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain("store-1");
    expect(compiled.sql).not.toContain("store-1");
  });

  it("requires the media permission, not the builder one", async () => {
    await expect(
      readMinkStorefrontMedia({
        ...ACTOR,
        permissions: { builder: ["view", "manage"] },
      }),
    ).rejects.toThrow("Media view permission");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bounds the list and reports that it was truncated", async () => {
    mocks.execute.mockResolvedValue({
      rows: Array.from({ length: 41 }, (_, i) => row(i)),
    });
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("clamps a model-supplied limit rather than trusting it", async () => {
    await readMinkStorefrontMedia(ACTOR, { limit: 5000 });
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    // 40 + 1, the one extra row that answers "is there more?".
    expect(compiled.params).toContain(41);
    await readMinkStorefrontMedia(ACTOR, { limit: "nonsense" });
    const second = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]);
    expect(second.params).toContain(41);
  });

  it("can find an older named image with a bounded filename search", async () => {
    const result = await readMinkStorefrontMedia(ACTOR, {
      query: "Summer_50% hero",
      limit: 10,
    });
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain("%Summer\\_50\\% hero%");
    expect(compiled.params).toContain(11);
    expect(compiled.sql).toContain("filename ilike");
    expect(result.query).toBe("Summer_50% hero");
  });

  it("bounds a filename, which is untrusted merchant text", async () => {
    mocks.execute.mockResolvedValue({
      rows: [{ ...row(1), filename: "f".repeat(500) }],
    });
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media[0].filename).toHaveLength(160);
  });
});

describe("Phase 9D ownership membership", () => {
  it("asks about the candidates rather than listing the whole library", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ url: row(1).url }] });
    const owned = await readOwnedStorefrontImageUrls("store-1", [
      row(1).url,
      row(2).url,
      row(1).url,
    ]);
    expect([...owned]).toEqual([row(1).url]);
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    // Deduplicated, and bound as one array parameter, never interpolated.
    expect(compiled.params).toContainEqual([row(1).url, row(2).url]);
    expect(compiled.sql).toContain('from "products"');
    expect(compiled.sql).toContain("unnest");
    expect(compiled.sql).not.toContain(row(1).url);
  });

  it("makes no query at all when nothing needs checking", async () => {
    expect([...(await readOwnedStorefrontImageUrls("store-1", []))]).toEqual(
      [],
    );
    expect([
      ...(await readOwnedStorefrontImageUrls("store-1", ["   "])),
    ]).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("takedown: a blocked file is neither listed nor owned", () => {
  it("leaves a blocked file out of the library list, told or not", async () => {
    mocks.blockedSet = blockedSet(
      "stores/store-1/media/1.webp",
      "stores/store-1/media/3.webp",
    );
    mocks.execute.mockResolvedValue({ rows: [row(1), row(2), row(3)] });
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media.map((m) => m.mediaId)).toEqual(["id-2"]);
    expect(JSON.stringify(result)).not.toContain("1.webp");
    expect(JSON.stringify(result)).not.toMatch(/block/i);
  });

  it("reads the blocked set only after its own scope has closed", async () => {
    await readMinkStorefrontMedia(ACTOR);
    const scope = vi.mocked(withService).mock.invocationCallOrder[0];
    const set = vi.mocked(blockedMedia).mock.invocationCallOrder[0];
    expect(set).toBeGreaterThan(scope);
    // The set read does not run inside the scope's callback.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("asks the same statement to leave out any address with a live file block", async () => {
    const db = { execute: mocks.execute };
    mocks.execute.mockResolvedValue({ rows: [{ url: row(2).url }] });
    const owned = await selectOwnedStorefrontImageUrls(db as never, "store-1", [
      row(1).url,
      row(2).url,
    ]);
    expect([...owned]).toEqual([row(2).url]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const query = compiled();
    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain("public.content_blocks");
    expect(query.sql).toContain("lifted_at is null");
    // Address and key arrays bound as parameters, never interpolated.
    expect(query.params).toContainEqual([row(1).url, row(2).url]);
    expect(query.params).toContainEqual([
      "stores/store-1/media/1.webp",
      "stores/store-1/media/2.webp",
    ]);
    expect(query.sql).not.toContain("stores/store-1/media/1.webp");
  });

  it("looks a store-domain theme address up by its bundled key as well", async () => {
    const db = { execute: mocks.execute };
    mocks.execute.mockResolvedValue({ rows: [] });
    const address = "https://shop.example.com/themes/basket/hero.webp";
    await selectOwnedStorefrontImageUrls(db as never, "store-1", [address]);
    const query = compiled();
    expect(query.params).toContainEqual([address, address]);
    expect(query.params).toContainEqual([
      "https://shop.example.com/themes/basket/hero.webp",
      "/themes/basket/hero.webp",
    ]);
  });

  it("adds no block lookup when no candidate is a media address", async () => {
    const db = { execute: mocks.execute };
    mocks.execute.mockResolvedValue({ rows: [] });
    await selectOwnedStorefrontImageUrls(db as never, "store-1", ["not a url"]);
    expect(compiled().sql).not.toContain("content_blocks");
  });

  it("names the blocked addresses on the caller's connection", async () => {
    const db = { execute: mocks.execute };
    mocks.execute.mockResolvedValue({ rows: [{ url: row(1).url }] });
    const blocked = await selectBlockedImageUrls(db as never, [
      ` ${row(1).url} `,
      row(1).url,
      "",
    ]);
    expect([...blocked]).toEqual([row(1).url]);
    expect(vi.mocked(withService)).not.toHaveBeenCalled();
    const query = compiled();
    expect(query.sql).toContain("public.content_blocks");
    expect(query.params).toContainEqual([row(1).url]);
    expect(query.params).toContainEqual(["stores/store-1/media/1.webp"]);
  });

  it("makes no query when there is nothing to look up", async () => {
    const db = { execute: mocks.execute };
    expect([...(await selectBlockedImageUrls(db as never, []))]).toEqual([]);
    expect([
      ...(await selectBlockedImageUrls(db as never, ["", "not a url"])),
    ]).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
